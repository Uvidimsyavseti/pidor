var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../server/cloudflare-worker.ts
import { DurableObject as DurableObject2 } from "cloudflare:workers";

// ../shared/initialDeal.ts
var INITIAL_DEAL_STEP_MS = 280;
var INITIAL_DEAL_LEAD_MS = 350;
var INITIAL_DEAL_FINISH_MS = 350;
function initialCardCount(withUnderlaid) {
  return withUnderlaid ? 3 : 1;
}
__name(initialCardCount, "initialCardCount");
function initialDealDuration(playerCount, withUnderlaid) {
  return initialCardCount(withUnderlaid) * playerCount * INITIAL_DEAL_STEP_MS + INITIAL_DEAL_FINISH_MS;
}
__name(initialDealDuration, "initialDealDuration");

// ../server/gameLogic.ts
var RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];
var SUITS = ["hearts", "diamonds", "clubs", "spades"];
var VIOLATION_WINDOW_MS = 15e3;
var RANK_VALUE = {
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  "J": 11,
  "Q": 12,
  "K": 13,
  "A": 14
};
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: `${rank}_of_${suit}` });
    }
  }
  return shuffle(deck);
}
__name(createDeck, "createDeck");
function shuffle(array) {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}
__name(shuffle, "shuffle");
var PidorGame = class {
  static {
    __name(this, "PidorGame");
  }
  state;
  penaltyDebts = {};
  penaltyQueue = [];
  previousDeckSuit = null;
  lockedDrawCards = [];
  violations = [];
  lastAccusationAt = {};
  reviewDeadlineAt = 0;
  onPenalty = null;
  snapshot() {
    return { state: this.state, penaltyDebts: this.penaltyDebts, penaltyQueue: this.penaltyQueue, previousDeckSuit: this.previousDeckSuit, lockedDrawCards: this.lockedDrawCards, violations: this.violations, lastAccusationAt: this.lastAccusationAt, reviewDeadlineAt: this.reviewDeadlineAt };
  }
  restore(saved) {
    this.state = saved.state;
    this.penaltyDebts = saved.penaltyDebts || {};
    this.penaltyQueue = saved.penaltyQueue || this.buildPenaltyQueue();
    this.previousDeckSuit = saved.previousDeckSuit || null;
    this.lockedDrawCards = saved.lockedDrawCards || [];
    this.violations = saved.violations || [];
    this.lastAccusationAt = saved.lastAccusationAt || {};
    this.reviewDeadlineAt = saved.reviewDeadlineAt || 0;
  }
  constructor(playerIds) {
    this.state = {
      phase: "LOBBY",
      players: playerIds.map((p) => ({
        id: p.id,
        name: p.name,
        hand: [],
        stumps: [],
        penalties: 0,
        isReady: false,
        onDuty: false,
        hasExited: false
      })),
      deck: [],
      trumpSuit: null,
      attackerId: null,
      currentTrick: [],
      trickTargetId: null,
      discardPile: [],
      turnIndex: 0,
      lastDrawnPlayerIdx: null,
      activeCard: null
    };
  }
  start(underlaidCards = this.state.underlaidCards !== false) {
    this.state.underlaidCards = underlaidCards;
    this.violations = [];
    this.lastAccusationAt = {};
    this.reviewDeadlineAt = 0;
    this.state.deck = createDeck();
    this.state.lastDrawEvent = void 0;
    this.lockedDrawCards = [];
    for (const player of this.state.players) {
      player.stumps = [];
      player.hand = [];
    }
    for (let round = 0; round < initialCardCount(underlaidCards); round++) {
      for (const player of this.state.players) player.stumps.push(this.state.deck.pop());
    }
    this.state.initialDealAt = Date.now() + INITIAL_DEAL_LEAD_MS;
    this.state.initialDealEndsAt = this.state.initialDealAt + initialDealDuration(this.state.players.length, underlaidCards);
    this.state.trumpSuit = null;
    this.previousDeckSuit = null;
    this.state.phase = "DEALING";
    this.state.turnIndex = 0;
    console.log("[GAME] Started. First turn:", this.state.players[0].name);
  }
  canBeat(card, target) {
    if (!target) return false;
    if (card.rank === "6") return card.suit !== "spades" && target.rank === "A";
    return RANK_VALUE[card.rank] === RANK_VALUE[target.rank] + 1;
  }
  canMoveTopCard(playerId) {
    const p = this.state.players.find((p2) => p2.id === playerId);
    const top = p?.stumps.at(-1);
    return this.state.phase === "DEALING" && !!top && p.stumps.length > (this.state.underlaidCards === false ? 1 : 3) && !this.lockedDrawCards.includes(top.id);
  }
  getPlayerIdx(id) {
    return this.state.players.findIndex((p) => p.id === id);
  }
  /**
   * Record an observable violation; never award a penalty automatically.
   * Another player must explicitly accuse the offender for it to count.
   */
  addPenalty(idx, reason, cardId) {
    if (idx < 0 || this.state.phase === "LOBBY" || this.state.phase === "ENDED") return;
    const offenderId = this.state.players[idx]?.id;
    if (!offenderId) return;
    const now = Date.now();
    this.violations = this.violations.filter((v) => now - v.createdAt < VIOLATION_WINDOW_MS);
    if (this.violations.some((v) => v.playerId === offenderId && v.reason === reason && v.cardId === cardId && now - v.createdAt < 2500)) return;
    this.violations.push({ id: crypto.randomUUID(), playerId: offenderId, reason, createdAt: now, cardId });
    if (this.violations.length > 80) this.violations.shift();
  }
  accusableTargets(observerId) {
    const now = Date.now();
    if (!this.state.players.some((p) => p.id === observerId)) return [];
    return [...new Set(this.violations.filter((v) => v.playerId !== observerId && now - v.createdAt < VIOLATION_WINDOW_MS).map((v) => v.playerId))];
  }
  canAccuseNow(playerId) {
    return Date.now() - (this.lastAccusationAt[playerId] || 0) >= 1500;
  }
  /**
   * A caught opportunistic draw is moved to the offender's pile even if
   * they already laid it on an opponent. If no one accuses within 15s,
   * its placement stands. The card is never copied or destroyed.
   */
  reclaimCaughtCard(offenderId, cardId) {
    const offender = this.state.players.find((p) => p.id === offenderId);
    if (!offender || offender.stumps.some((c) => c.id === cardId)) return;
    let seized;
    if (this.state.activeCard?.card.id === cardId) {
      seized = this.state.activeCard.card;
      this.state.activeCard = null;
    } else {
      for (const player of this.state.players) {
        for (const pile of [player.stumps, player.hand]) {
          const index = pile.findIndex((c) => c.id === cardId);
          if (index !== -1) {
            seized = pile.splice(index, 1)[0];
            break;
          }
        }
        if (seized) break;
      }
    }
    if (seized) {
      offender.stumps.push(seized);
      this.lockedDrawCards.push(cardId);
      this.checkPhaseEnd();
    }
  }
  accuse(accuserId, accusedId) {
    if (this.state.phase === "LOBBY" || this.state.phase === "ENDED") return null;
    const accuser = this.state.players.find((p) => p.id === accuserId && !p.hasExited);
    const accused = this.state.players.find((p) => p.id === accusedId);
    if (!accuser || !accused || accuserId === accusedId) return null;
    const now = Date.now();
    if (now - (this.lastAccusationAt[accuserId] || 0) < 1500) return null;
    this.lastAccusationAt[accuserId] = now;
    this.violations = this.violations.filter((v) => now - v.createdAt < VIOLATION_WINDOW_MS);
    const index = this.violations.findIndex((v) => v.playerId === accusedId);
    const correct = index !== -1;
    const confirmedViolation = correct ? this.violations.splice(index, 1)[0] : null;
    const reason = confirmedViolation?.reason || "\u041B\u043E\u0436\u043D\u043E\u0435 \u043E\u0431\u0432\u0438\u043D\u0435\u043D\u0438\u0435";
    if (confirmedViolation?.cardId) this.reclaimCaughtCard(accusedId, confirmedViolation.cardId);
    const punished = correct ? accused : accuser;
    punished.penalties++;
    this.onPenalty?.(punished.id, reason);
    return { correct, accusedId, penalizedId: punished.id, reason };
  }
  expireReview() {
    if (this.state.phase !== "PENALTY_REVIEW" || !this.reviewDeadlineAt || Date.now() < this.reviewDeadlineAt) return false;
    this.violations = [];
    this.transitionToPenaltyDistribution();
    return true;
  }
  finishReview(playerId) {
    if (this.state.phase !== "PENALTY_REVIEW") return false;
    const player = this.state.players.find((p) => p.id === playerId);
    if (!player) return false;
    player.isReady = true;
    if (this.state.players.every((p) => p.isReady || p.isBot)) {
      this.violations = [];
      this.transitionToPenaltyDistribution();
    }
    return true;
  }
  enterReview() {
    this.state.phase = "PENALTY_REVIEW";
    this.reviewDeadlineAt = Date.now() + VIOLATION_WINDOW_MS;
    for (const player of this.state.players) player.isReady = !!player.isBot;
  }
  // --- Dealing Phase ---
  takeFromDeck(actorId) {
    const idx = this.getPlayerIdx(actorId);
    if (idx === -1 || this.state.phase !== "DEALING" || !this.state.deck.length) return false;
    const outOfTurn = idx !== this.state.turnIndex;
    if (this.state.activeCard) {
      if (this.state.activeCard.ownerId === actorId) this.addPenalty(idx, "\u041F\u044B\u0442\u0430\u0435\u0442\u0441\u044F \u0432\u044B\u0442\u044F\u043D\u0443\u0442\u044C \u0432\u0442\u043E\u0440\u0443\u044E \u043A\u0430\u0440\u0442\u0443");
      return false;
    }
    if (!outOfTurn && this.canMoveTopCard(actorId)) {
      const targetIdx = this.findOtherBeatTarget(idx);
      if (targetIdx !== -1) this.addPenalty(idx, "\u041D\u0435 \u043A\u0438\u043D\u0443\u043B \u0441\u0432\u043E\u044E \u043A\u0430\u0440\u0442\u0443 \u043D\u0430 " + this.state.players[targetIdx].name);
    }
    const card = this.state.deck.pop();
    const isSpadeSix = card.rank === "6" && card.suit === "spades";
    const isLast = this.state.deck.length === 0;
    const originalTop = this.state.players[idx].stumps.at(-1);
    if (isLast) this.state.trumpSuit = card.suit === "spades" ? null : card.suit;
    this.previousDeckSuit = card.suit;
    this.state.lastDrawnPlayerIdx = idx;
    this.state.lastDrawEvent = {
      playerId: actorId,
      outOfTurn,
      forcedSelf: isSpadeSix || isLast,
      createdAt: Date.now()
    };
    if (outOfTurn) this.addPenalty(idx, "\u0412\u044B\u0442\u044F\u043D\u0443\u043B \u043A\u0430\u0440\u0442\u0443 \u0432\u043D\u0435 \u043E\u0447\u0435\u0440\u0435\u0434\u0438", card.id);
    if (isSpadeSix) this.addPenalty(idx, "\u0412\u044B\u0442\u044F\u043D\u0443\u043B \u043F\u0438\u043A\u043E\u0432\u0443\u044E \u0448\u0435\u0441\u0442\u0451\u0440\u043A\u0443");
    if (isSpadeSix || isLast) {
      this.lockedDrawCards.push(card.id);
      this.state.players[idx].stumps.push(card);
      if (!outOfTurn && !this.canBeat(card, originalTop)) {
        this.state.turnIndex = (this.state.turnIndex + 1) % this.state.players.length;
      }
      this.checkPhaseEnd();
      return true;
    }
    this.state.activeCard = { card, ownerId: actorId, fromDeck: true };
    return true;
  }
  takeFromPile(actorId, cardId) {
    const idx = this.getPlayerIdx(actorId);
    if (idx === -1 || this.state.phase !== "DEALING" || this.state.activeCard) return false;
    if (idx !== this.state.turnIndex) return false;
    const p = this.state.players[idx];
    if (p.stumps.length <= (this.state.underlaidCards === false ? 1 : 3)) return false;
    const top = p.stumps[p.stumps.length - 1];
    if (top.id !== cardId || this.lockedDrawCards.includes(cardId)) return false;
    p.stumps.pop();
    this.state.activeCard = { card: top, ownerId: actorId, fromDeck: false };
    return true;
  }
  moveTopTo(actorId, targetId) {
    if (!this.canMoveTopCard(actorId) || this.state.activeCard) return false;
    const actor = this.state.players.find((p) => p.id === actorId);
    const top = actor.stumps.at(-1);
    if (!this.state.players.some((p) => p.id === targetId)) return false;
    if (!this.takeFromPile(actorId, top.id)) return false;
    if (this.placeActiveCard(actorId, targetId)) return true;
    actor.stumps.push(top);
    this.state.activeCard = null;
    return false;
  }
  drawTo(actorId, targetId) {
    if (!this.state.players.some((p) => p.id === actorId) || !this.state.players.some((p) => p.id === targetId) || this.state.phase !== "DEALING" || !this.state.deck.length || this.state.activeCard) return false;
    if (!this.takeFromDeck(actorId)) return false;
    return !this.state.activeCard || this.placeActiveCard(actorId, targetId);
  }
  placeActiveCard(actorId, targetId) {
    const actorIdx = this.getPlayerIdx(actorId);
    const targetIdx = this.getPlayerIdx(targetId);
    if (actorIdx < 0 || targetIdx < 0 || !this.state.activeCard) return false;
    if (this.state.activeCard.ownerId !== actorId) return false;
    const { card, fromDeck } = this.state.activeCard;
    if (!fromDeck && actorIdx === targetIdx) return false;
    const opportunistic = actorIdx !== this.state.turnIndex && fromDeck && this.state.lastDrawEvent?.playerId === actorId && this.state.lastDrawEvent.outOfTurn;
    if (actorIdx !== this.state.turnIndex && !opportunistic) return false;
    const isSelf = actorIdx === targetIdx;
    const top = this.state.players[targetIdx].stumps.at(-1);
    const legal = top ? this.canBeat(card, top) : isSelf;
    let first = -1;
    for (let i = 1; i < this.state.players.length; i++) {
      const idx = (actorIdx + i) % this.state.players.length;
      if (this.canBeat(card, this.state.players[idx].stumps.at(-1))) {
        first = idx;
        break;
      }
    }
    if (!isSelf && !legal) this.addPenalty(actorIdx, "\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u043F\u043E\u0441\u043B\u0435\u0434\u043E\u0432\u0430\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C", card.id);
    else if (isSelf && first !== -1) this.addPenalty(actorIdx, "\u041D\u0435 \u043F\u0435\u0440\u0435\u043A\u0438\u043D\u0443\u043B \u043A\u0430\u0440\u0442\u0443 \u0441\u043E\u043F\u0435\u0440\u043D\u0438\u043A\u0443", card.id);
    else if (!isSelf && first !== -1 && first !== targetIdx) {
      this.addPenalty(actorIdx, "\u041F\u0440\u043E\u043F\u0443\u0441\u0442\u0438\u043B \u0438\u0433\u0440\u043E\u043A\u0430 \u043F\u043E \u043A\u0440\u0443\u0433\u0443", card.id);
    }
    this.state.players[targetIdx].stumps.push(card);
    this.state.activeCard = null;
    if (!opportunistic && (isSelf || !legal)) {
      this.state.turnIndex = (actorIdx + 1) % this.state.players.length;
    }
    this.checkPhaseEnd();
    return true;
  }
  findOtherBeatTarget(actorIdx) {
    const p = this.state.players[actorIdx];
    if (p.stumps.length <= (this.state.underlaidCards === false ? 1 : 3)) return -1;
    const top = p.stumps[p.stumps.length - 1];
    for (let i = 1; i < this.state.players.length; i++) {
      const idx = (actorIdx + i) % this.state.players.length;
      if (this.canBeat(top, this.state.players[idx].stumps[this.state.players[idx].stumps.length - 1])) return idx;
    }
    return -1;
  }
  checkPhaseEnd() {
    if (this.state.phase === "DEALING" && this.state.deck.length === 0 && !this.state.activeCard) {
      this.enterReview();
    }
  }
  buildPenaltyQueue() {
    const queue = [];
    const debts = Object.fromEntries(Object.entries(this.penaltyDebts).map(([receiver, givers]) => [receiver, { ...givers }]));
    let pending = true;
    while (pending) {
      pending = false;
      for (const giver of this.state.players) {
        for (const receiver of this.state.players) {
          if ((debts[receiver.id]?.[giver.id] || 0) > 0) {
            queue.push({ giverId: giver.id, receiverId: receiver.id });
            debts[receiver.id][giver.id]--;
            pending = true;
            break;
          }
        }
      }
    }
    return queue;
  }
  currentPenaltyTurn() {
    return this.penaltyQueue[0] || null;
  }
  transitionToPenaltyDistribution() {
    this.lockedDrawCards = [];
    this.state.phase = "PENALTY_DISTRIBUTION";
    for (const p of this.state.players) p.hand = p.stumps.splice(this.state.underlaidCards === false ? 0 : 2);
    this.penaltyDebts = {};
    for (const giver of this.state.players) {
      let available = Math.max(0, giver.hand.length - 1);
      for (const receiver of this.state.players) {
        if (giver.id === receiver.id || receiver.penalties <= 0 || available <= 0) continue;
        const owed = Math.min(receiver.penalties, available);
        (this.penaltyDebts[receiver.id] ??= {})[giver.id] = owed;
        available -= owed;
      }
    }
    const total = Object.values(this.penaltyDebts).flatMap((x) => Object.values(x)).reduce((a, b) => a + b, 0);
    this.penaltyQueue = this.buildPenaltyQueue();
    if (total === 0) this.transitionToMainGame();
  }
  givePenaltyCard(giverId, cardId, receiverId) {
    const giver = this.state.players.find((p) => p.id === giverId);
    const current = this.currentPenaltyTurn();
    if (!giver || giver.hand.length <= 1 || current?.giverId !== giverId || current.receiverId !== receiverId || !this.penaltyDebts[receiverId]?.[giverId]) return false;
    const idx = giver.hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return false;
    this.state.players.find((p) => p.id === receiverId).hand.push(giver.hand.splice(idx, 1)[0]);
    this.penaltyDebts[receiverId][giverId]--;
    this.penaltyQueue.shift();
    let rem = 0;
    for (const r in this.penaltyDebts) for (const g in this.penaltyDebts[r]) rem += this.penaltyDebts[r][g];
    if (rem === 0) this.transitionToMainGame();
    return true;
  }
  transitionToMainGame() {
    this.reviewDeadlineAt = 0;
    this.penaltyQueue = [];
    this.state.phase = "MAIN_GAME";
    this.state.trickTargetId = null;
    this.state.turnIndex = ((this.state.lastDrawnPlayerIdx ?? -1) + 1) % this.state.players.length;
    while (this.state.players[this.state.turnIndex].hasExited) this.state.turnIndex = (this.state.turnIndex + 1) % this.state.players.length;
  }
  // --- Main Game ---
  playCard(playerId, cardId) {
    const idx = this.getPlayerIdx(playerId);
    if (idx !== this.state.turnIndex) {
      this.addPenalty(idx, "\u0412\u043D\u0435 \u043E\u0447\u0435\u0440\u0435\u0434\u0438");
      return;
    }
    const player = this.state.players[idx];
    const cIdx = player.hand.findIndex((c) => c.id === cardId);
    if (cIdx === -1) return;
    const card = player.hand[cIdx];
    const target = this.state.currentTrick.length > 0 ? this.state.currentTrick[this.state.currentTrick.length - 1] : null;
    if (this.isLegalMove(card, target)) {
      player.hand.splice(cIdx, 1);
      this.state.currentTrick.push(card);
      this.advanceTurn();
      this.state.trickTargetId = this.state.players[this.state.turnIndex]?.id || null;
      this.checkTrickCompletion();
    } else this.addPenalty(idx, "\u041D\u0435 \u0431\u044C\u0435\u0442");
  }
  isLegalMove(card, target) {
    if (!target) return true;
    if (card.rank === "6" && target.rank === "A" && card.suit === target.suit) {
      return card.suit !== "spades";
    }
    const higher = RANK_VALUE[card.rank] > RANK_VALUE[target.rank];
    if (!this.state.trumpSuit) return card.suit === target.suit && higher;
    if (target.rank === "A" && (target.suit === "spades" || target.suit === this.state.trumpSuit)) return false;
    if (target.suit === "spades") return card.suit === "spades" && higher;
    if (target.suit === this.state.trumpSuit) return card.suit === this.state.trumpSuit && higher;
    if (card.suit === this.state.trumpSuit) return true;
    return card.suit === target.suit && higher;
  }
  takeTrick(playerId) {
    const idx = this.getPlayerIdx(playerId);
    if (idx !== this.state.turnIndex || this.state.currentTrick.length === 0) return;
    this.state.players[idx].hand.push(this.state.currentTrick.shift());
    this.advanceTurn();
    this.state.trickTargetId = this.state.currentTrick.length ? this.state.players[this.state.turnIndex]?.id || null : null;
  }
  takeStumps(playerId) {
    const p = this.state.players.find((p2) => p2.id === playerId);
    if (p && this.state.phase === "MAIN_GAME" && p.hand.length === 0 && this.state.currentTrick.length === 0) {
      p.hand.push(...p.stumps);
      p.stumps = [];
    }
  }
  exitGame(playerId) {
    const p = this.state.players.find((p2) => p2.id === playerId);
    if (p && this.state.phase === "MAIN_GAME" && this.state.currentTrick.length === 0 && p.hand.length === 0 && p.stumps.length === 0) {
      if (p.hasExited) return;
      p.hasExited = true;
      const remaining = this.state.players.filter((p2) => !p2.hasExited);
      if (remaining.length <= 1) {
        if (remaining.length) remaining[0].onDuty = true;
        this.state.phase = "ENDED";
      } else if (this.state.players[this.state.turnIndex]?.id === playerId) {
        this.advanceTurn();
      }
    }
  }
  advanceTurn() {
    let next = (this.state.turnIndex + 1) % this.state.players.length;
    while (this.state.players[next].hasExited) next = (next + 1) % this.state.players.length;
    this.state.turnIndex = next;
  }
  checkTrickCompletion() {
    const count = this.state.players.filter((p) => !p.hasExited).length;
    if (this.state.currentTrick.length === count) {
      this.state.discardPile.push(...this.state.currentTrick);
      this.state.currentTrick = [];
      this.state.trickTargetId = null;
    }
  }
};

// ../server/botStrategy.ts
function cardCost(card, trump) {
  return RANK_VALUE[card.rank] + (card.suit === trump ? 30 : 0) + (card.suit === "spades" ? 5 : 0);
}
__name(cardCost, "cardCost");
function firstTarget(game, actorId, card) {
  const players = game.state.players;
  const actorIdx = players.findIndex((player) => player.id === actorId);
  for (let i = 1; i < players.length; i++) {
    const target = players[(actorIdx + i) % players.length];
    const top = target.stumps.at(-1);
    if (top && game.canBeat(card, top)) return target.id;
  }
  return actorId;
}
__name(firstTarget, "firstTarget");
function nextBotMove(game, botIds) {
  const state = game.state;
  const isBot = /* @__PURE__ */ __name((id) => botIds.includes(id), "isBot");
  if (state.phase === "LOBBY" || state.phase === "ENDED") return null;
  const challenger = state.players.find((p) => isBot(p.id) && !p.hasExited && game.canAccuseNow(p.id) && game.accusableTargets(p.id).length > 0);
  if (challenger && Math.random() < 0.55) {
    const opponentId = game.accusableTargets(challenger.id)[0];
    return { type: "accuse", actorId: challenger.id, accusedId: opponentId };
  }
  if (state.phase === "PENALTY_REVIEW") return null;
  if (state.phase === "DEALING") {
    const actor2 = state.players[state.turnIndex];
    if (!actor2 || !isBot(actor2.id)) return null;
    if (state.activeCard) {
      if (state.activeCard.ownerId !== actor2.id) return null;
      return {
        type: "placeActiveCard",
        actorId: actor2.id,
        targetId: state.activeCard.fromDeck && state.deck.length === 0 ? actor2.id : firstTarget(game, actor2.id, state.activeCard.card)
      };
    }
    const top = actor2.stumps.at(-1);
    if (top && game.canMoveTopCard(actor2.id) && firstTarget(game, actor2.id, top) !== actor2.id) {
      return { type: "takeFromPile", actorId: actor2.id, cardId: top.id };
    }
    return state.deck.length ? { type: "drawCardFromDeck", actorId: actor2.id } : null;
  }
  if (state.phase === "PENALTY_DISTRIBUTION") {
    const turn = game.currentPenaltyTurn();
    if (!turn || !isBot(turn.giverId)) return null;
    const giver = state.players.find((p) => p.id === turn.giverId);
    if (!giver || giver.hand.length < 2) return null;
    const card = [...giver.hand].sort((a, b) => cardCost(b, state.trumpSuit) - cardCost(a, state.trumpSuit))[0];
    return card ? { type: "givePenaltyCard", actorId: giver.id, cardId: card.id, receiverId: turn.receiverId } : null;
  }
  if (state.currentTrick.length === 0) {
    for (const player of state.players) {
      if (!isBot(player.id) || player.hasExited || player.hand.length > 0) continue;
      return { type: player.stumps.length ? "takeStumps" : "exitGame", actorId: player.id };
    }
  }
  const actor = state.players[state.turnIndex];
  if (!actor || !isBot(actor.id) || actor.hasExited) return null;
  if (!actor.hand.length) {
    return state.currentTrick.length ? { type: "takeTrick", actorId: actor.id } : null;
  }
  const last = state.currentTrick.at(-1) || null;
  if (last && Math.random() < 0.12) {
    return { type: "takeTrick", actorId: actor.id };
  }
  const playable = actor.hand.filter((card) => game.isLegalMove(card, last)).sort((a, b) => cardCost(a, state.trumpSuit) - cardCost(b, state.trumpSuit));
  if (playable.length) {
    return { type: "playCard", actorId: actor.id, cardId: playable[0].id };
  }
  return state.currentTrick.length ? { type: "takeTrick", actorId: actor.id } : null;
}
__name(nextBotMove, "nextBotMove");
function applyBotMove(game, move) {
  switch (move.type) {
    case "accuse":
      return game.accuse(move.actorId, move.accusedId) !== null;
    case "drawCardFromDeck":
      return game.takeFromDeck(move.actorId);
    case "takeFromPile":
      return game.takeFromPile(move.actorId, move.cardId);
    case "placeActiveCard":
      return game.placeActiveCard(move.actorId, move.targetId);
    case "givePenaltyCard":
      return game.givePenaltyCard(move.actorId, move.cardId, move.receiverId);
    case "playCard": {
      const before = game.state.players.find((p) => p.id === move.actorId)?.hand.length;
      game.playCard(move.actorId, move.cardId);
      const after = game.state.players.find((p) => p.id === move.actorId)?.hand.length;
      return before !== void 0 && after === before - 1;
    }
    case "takeTrick": {
      const count = game.state.currentTrick.length;
      game.takeTrick(move.actorId);
      return game.state.currentTrick.length === count - 1;
    }
    case "takeStumps": {
      const before = game.state.players.find((p) => p.id === move.actorId)?.stumps.length ?? 0;
      game.takeStumps(move.actorId);
      return before > 0 && game.state.players.find((p) => p.id === move.actorId)?.stumps.length === 0;
    }
    case "exitGame": {
      game.exitGame(move.actorId);
      return !!game.state.players.find((p) => p.id === move.actorId)?.hasExited;
    }
  }
}
__name(applyBotMove, "applyBotMove");

// ../server/telegram.ts
function secretEquals(provided, expected) {
  const encoder = new TextEncoder();
  const left = encoder.encode(provided);
  const right = encoder.encode(expected);
  let mismatch = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    mismatch |= (left[i] || 0) ^ (right[i] || 0);
  }
  return mismatch === 0;
}
__name(secretEquals, "secretEquals");
async function callTelegram(env, method, body) {
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error(method + ": " + (json.description || "Telegram API failure"));
  return json;
}
__name(callTelegram, "callTelegram");
function miniAppLink(origin, mode) {
  return origin + (mode === "bot" ? "/api/app?mode=bot&ui=20261112-fix2" : "/api/app?mode=friends&ui=20261112-fix2");
}
__name(miniAppLink, "miniAppLink");
async function replyToMessage(env, update, origin) {
  const message = update.message;
  if (!message?.chat || message.chat.type !== "private") return;
  const raw = (message.text || "").trim();
  const command = raw.split(/\s+/)[0].split("@")[0].toLowerCase();
  if (!["/start", "/play", "/game", "/help"].includes(command)) return;
  if (command === "/start") {
    try { await callTelegram(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "🎮 Играть", web_app: { url: origin + "/api/app?ui=20261112-fix2" } } }); }
    catch { /* Optional menu migration; /start links still work. */ }
  }

  const greeting = message.from?.first_name ? "\u041F\u0440\u0438\u0432\u0435\u0442, " + message.from.first_name.slice(0, 32) + "!\n\n" : "\u041F\u0440\u0438\u0432\u0435\u0442!\n\n";
  const text = command === "/help" ? "PIDOR \u2014 \u043A\u0430\u0440\u0442\u043E\u0447\u043D\u0430\u044F \u0438\u0433\u0440\u0430 \u043D\u0430 36 \u043A\u0430\u0440\u0442.\n\n\u0418\u0433\u0440\u0430\u0439\u0442\u0435 \u0441 \u043A\u043E\u043C\u043F\u044C\u044E\u0442\u0435\u0440\u043E\u043C \u0438\u043B\u0438 \u043F\u0440\u0438\u0433\u043B\u0430\u0441\u0438\u0442\u0435 \u0434\u0440\u0443\u0437\u0435\u0439. \u041E\u0442\u043A\u0440\u043E\u0439 \u0438\u0433\u0440\u0443 \u043A\u043D\u043E\u043F\u043A\u043E\u0439 \u043D\u0438\u0436\u0435. \u0412\u043D\u0443\u0442\u0440\u0438 \u0435\u0441\u0442\u044C \u043A\u0440\u0430\u0442\u043A\u0438\u0435 \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u0438 \u0432\u044B\u0431\u043E\u0440 \u0440\u0435\u0436\u0438\u043C\u0430." : greeting + "\u0414\u043E\u0431\u0440\u043E \u043F\u043E\u0436\u0430\u043B\u043E\u0432\u0430\u0442\u044C \u0432 PIDOR!\n\n\u0412\u044B\u0431\u0438\u0440\u0430\u0439: \u0441\u044B\u0433\u0440\u0430\u0442\u044C \u0441 \u0431\u043E\u0442\u043E\u043C \u0438\u043B\u0438 \u0441\u043E\u0431\u0440\u0430\u0442\u044C \u0434\u0440\u0443\u0437\u0435\u0439 \u0437\u0430 \u043E\u0434\u043D\u0438\u043C \u0441\u0442\u043E\u043B\u043E\u043C.";
  await callTelegram(env, "sendMessage", {
    chat_id: message.chat.id,
    text,
    reply_markup: { inline_keyboard: [
      [{ text: "\u{1F916} \u0418\u0433\u0440\u0430\u0442\u044C \u0441 \u0431\u043E\u0442\u043E\u043C", web_app: { url: miniAppLink(origin, "bot") } }],
      [{ text: "\u{1F0CF} \u0418\u0433\u0440\u0430\u0442\u044C \u0441 \u0434\u0440\u0443\u0437\u044C\u044F\u043C\u0438", web_app: { url: miniAppLink(origin, "friends") } }]
    ] }
  });
}
__name(replyToMessage, "replyToMessage");
async function activateBot(env, origin) {
  try {
    const bot = await callTelegram(env, "getMe", {});
    const webhook = await callTelegram(env, "setWebhook", {
      url: origin + "/telegram/webhook",
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: false
    });
    const menu = await callTelegram(env, "setChatMenuButton", {
      menu_button: { type: "web_app", text: "\u{1F3AE} \u0418\u0433\u0440\u0430\u0442\u044C", web_app: { url: origin + "/api/app?ui=20261112-fix2" } }
    });
    await callTelegram(env, "setMyCommands", {
      commands: [
        { command: "start", description: "\u041E\u0442\u043A\u0440\u044B\u0442\u044C PIDOR" },
        { command: "play", description: "\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u0438\u0433\u0440\u0443 \u0441 \u0431\u043E\u0442\u043E\u043C \u0438\u043B\u0438 \u0434\u0440\u0443\u0437\u044C\u044F\u043C\u0438" },
        { command: "help", description: "\u041A\u0430\u043A \u0438\u0433\u0440\u0430\u0442\u044C" }
      ]
    });
    return Response.json({ ok: true, username: bot.result?.username, webhook: webhook.ok, menu: menu.ok });
  } catch (e) {
    console.error("Telegram activation error", String(e).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]"));
    return Response.json({ error: "Telegram configuration failed. Check BotFather token and logs." }, { status: 502 });
  }
}
__name(activateBot, "activateBot");
async function handleTelegram(request, env) {
  const url = new URL(request.url);
  const configured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET);
  if (url.pathname === "/telegram/status" && request.method === "GET") {
    return Response.json({ ready: configured, message: configured ? "Bot credentials configured" : "Waiting for BotFather credentials" });
  }
  if (url.pathname === "/telegram/activate" && request.method === "POST") {
    if (!configured) return Response.json({ error: "Configure Cloudflare secrets first" }, { status: 503 });
    if (!secretEquals(request.headers.get("X-Telegram-Setup-Key") || "", env.TELEGRAM_WEBHOOK_SECRET)) {
      return Response.json({ error: "Unauthorized" }, { status: 403 });
    }
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) {
      return Response.json({ error: "Webhook secret must be 1-256 chars (letters, numbers, _ or -)" }, { status: 400 });
    }
    return activateBot(env, url.origin);
  }
  if (url.pathname === "/telegram/webhook" && request.method === "POST") {
    if (!configured) return new Response("Not configured", { status: 503 });
    const received = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!secretEquals(received, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (Number(request.headers.get("content-length") || 0) > 64e3) {
      return new Response("Payload too large", { status: 413 });
    }
    try {
      const update = await request.json();
      await replyToMessage(env, update, url.origin);
      return new Response("OK", { status: 200 });
    } catch (e) {
      console.warn("Telegram update handling error", String(e).slice(0, 240));
      return new Response("Telegram update error", { status: 500 });
    }
  }
  return new Response("Not found", { status: 404 });
}
__name(handleTelegram, "handleTelegram");

// ../server/lobbyDirectory.ts
import { DurableObject } from "cloudflare:workers";
var STALE_AFTER_MS = 9e4;
var MAX_TABLES = 150;
function cleanName(input) {
  if (typeof input !== "string") return "\u0421\u0442\u043E\u043B \u0443 \u043A\u0430\u043C\u0438\u043D\u0430";
  return input.trim().replace(/\s+/g, " ").slice(0, 36) || "\u0421\u0442\u043E\u043B \u0443 \u043A\u0430\u043C\u0438\u043D\u0430";
}
__name(cleanName, "cleanName");
var LobbyDirectory = class extends DurableObject {
  static {
    __name(this, "LobbyDirectory");
  }
  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    const previous = await this.ctx.storage.get("tables") || [];
    const tables = previous.filter((room) => now - room.updatedAt < STALE_AFTER_MS && room.seats > 0 || now - room.createdAt < STALE_AFTER_MS && room.seats === 0);
    if (tables.length !== previous.length) await this.ctx.storage.put("tables", tables);
    if (url.pathname === "/list" && request.method === "GET") {
      const free = tables.filter((t) => t.visibility === "public" && t.phase === "LOBBY" && t.seats > 0 && t.seats < t.capacity).sort((a, b) => b.seats - a.seats || b.updatedAt - a.updatedAt);
      return Response.json({ tables: free.slice(0, 40), updatedAt: now }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/create" && request.method === "POST") {
      if (tables.length >= MAX_TABLES) {
        return Response.json({ error: "\u0412\u0441\u0435 \u0441\u0442\u043E\u043B\u044B \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u0437\u0430\u043D\u044F\u0442\u044B. \u041F\u043E\u0432\u0442\u043E\u0440\u0438 \u043F\u043E\u043F\u044B\u0442\u043A\u0443." }, { status: 429 });
      }
      const data = await request.json().catch(() => ({}));
      const id = "t_" + crypto.randomUUID().replace(/-/g, "").slice(0, 14);
      const table = {
        id,
        title: cleanName(data.title),
        visibility: data.visibility === "private" ? "private" : "public",
        underlaidCards: data.underlaidCards !== false,
        phase: "LOBBY",
        seats: 0,
        capacity: 6,
        players: [],
        createdAt: now,
        updatedAt: now
      };
      tables.push(table);
      await this.ctx.storage.put("tables", tables);
      await this.ctx.storage.setAlarm(now + STALE_AFTER_MS);
      return Response.json({ table }, { status: 201, headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/get" && request.method === "GET") {
      const table = tables.find((t) => t.id === url.searchParams.get("id"));
      return table ? Response.json({ table }) : Response.json({ error: "\u0421\u0442\u043E\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" }, { status: 404 });
    }
    if (url.pathname === "/sync" && request.method === "POST") {
      const data = await request.json();
      if (!data.id || !/^[a-zA-Z0-9_-]{1,48}$/.test(data.id)) return new Response("Bad room", { status: 400 });
      const index = tables.findIndex((t) => t.id === data.id);
      const current = index >= 0 ? tables[index] : {
        id: data.id,
        title: "\u0421\u0442\u043E\u043B " + data.id.slice(-6),
        visibility: "private",
        phase: "LOBBY",
        seats: 0,
        capacity: 6,
        players: [],
        createdAt: now,
        updatedAt: now
      };
      const connected = Array.isArray(data.players) ? data.players.filter((p) => typeof p === "string" && p.length <= 32).slice(0, 6) : [];
      const next = {
        ...current,
        seats: connected.length,
        players: connected,
        phase: data.phase || current.phase,
        updatedAt: now
      };
      if (index < 0) tables.push(next);
      else tables[index] = next;
      await this.ctx.storage.put("tables", tables);
      await this.ctx.storage.setAlarm(now + STALE_AFTER_MS);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/remove" && request.method === "POST") {
      const { id } = await request.json();
      await this.ctx.storage.put("tables", tables.filter((t) => t.id !== id));
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }
  async alarm() {
    const now = Date.now();
    const tables = await this.ctx.storage.get("tables") || [];
    const alive = tables.filter((t) => now - t.updatedAt < STALE_AFTER_MS && t.seats > 0 || now - t.createdAt < STALE_AFTER_MS && t.seats === 0);
    if (alive.length !== tables.length) await this.ctx.storage.put("tables", alive);
    if (alive.length) await this.ctx.storage.setAlarm(now + 45e3);
  }
};

// ../server/drawReveal.ts
function createDrawReveal(playerId, topBeforeDraw, deckLengthBefore, deckLengthAfter, targetPlayerId) {
  if (!playerId || !topBeforeDraw || deckLengthBefore !== deckLengthAfter + 1) return null;
  return {
    id: crypto.randomUUID(),
    playerId,
    card: { ...topBeforeDraw },
    ...targetPlayerId ? { targetPlayerId } : {},
    createdAt: Date.now()
  };
}
__name(createDrawReveal, "createDrawReveal");

// ../server/visibility.ts
function concealed(id) {
  return { id: "masked-" + id, rank: "6", suit: "clubs" };
}
__name(concealed, "concealed");
function visibleState(state, viewerId) {
  const view = structuredClone(state);
  view.deck = state.deck.map((_, i) => concealed("deck-" + i));
  view.players = view.players.map((player) => {
    const original = state.players.find((p) => p.id === player.id);
    if (player.id !== viewerId) {
      player.hand = original.hand.map((_, i) => concealed("hand-" + i));
    }
    player.stumps = original.stumps.map((card, i) => (state.phase === "DEALING" || state.phase === "PENALTY_REVIEW") && i === original.stumps.length - 1 && i >= (state.underlaidCards === false ? 0 : 2) ? card : concealed("stumps-" + player.id + "-" + i));
    return player;
  });
  return view;
}
__name(visibleState, "visibleState");

// ../server/actionReplay.ts
var MAX_ACTIONS_PER_PLAYER = 96;
var ACTION_ID_FORMAT = /^[A-Za-z0-9_-]{8,64}$/;
function rememberAction(history, playerId, actionId) {
  if (!ACTION_ID_FORMAT.test(actionId) || !playerId) return false;
  const seen = history[playerId] || [];
  if (seen.includes(actionId)) return false;
  seen.push(actionId);
  if (seen.length > MAX_ACTIONS_PER_PLAYER) {
    seen.splice(0, seen.length - MAX_ACTIONS_PER_PLAYER);
  }
  history[playerId] = seen;
  return true;
}
__name(rememberAction, "rememberAction");
var STATE_CHANGING_ACTIONS = /* @__PURE__ */ new Set([
  "startGame",
  "accusePlayer",
  "finishReview",
  "drawTo",
  "moveTopTo",
  "drawCardFromDeck",
  "takeFromPile",
  "placeActiveCard",
  "givePenaltyCard",
  "playCard",
  "takeTrick",
  "takeStumps",
  "exitGame"
]);

// ../server/cloudflare-worker.ts
function emit(socket, type, data) {
  try {
    socket.send(JSON.stringify({ type, data }));
  } catch {
  }
}
__name(emit, "emit");
async function verifyTelegram(initData, botToken) {
  if (!botToken || initData.length > 8192) return null;
  try {
    const params = new URLSearchParams(initData);
    const authDate = Number(params.get("auth_date"));
    const hash = params.get("hash") || "";
    if (!/^[0-9a-f]{64}$/i.test(hash)) return null;
    const now = Math.floor(Date.now() / 1e3);
    if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > 86400) return null;
    const check = [...params.entries()].filter(([k]) => k !== "hash").sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + v).join("\n");
    const enc = new TextEncoder();
    const key1 = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", key1, enc.encode(botToken));
    const key2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const actual = new Uint8Array(await crypto.subtle.sign("HMAC", key2, enc.encode(check)));
    const expected = new Uint8Array(hash.match(/../g).map((x) => parseInt(x, 16)));
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    if (diff !== 0) return null;
    const user = JSON.parse(params.get("user") || "{}");
    return Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
  } catch {
    return null;
  }
}
__name(verifyTelegram, "verifyTelegram");
var PidorRoom = class extends DurableObject2 {
  static {
    __name(this, "PidorRoom");
  }
  game = new PidorGame([]);
  sessions = {};
  botIds = [];
  roomMode = "friends";
  roomId = "";
  idleDeadline = 0;
  processedActions = {};
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const [snapshot, sessions, bots, mode, roomId, idleDeadline, processedActions] = await Promise.all([
        ctx.storage.get("game"),
        ctx.storage.get("sessions"),
        ctx.storage.get("bots"),
        ctx.storage.get("roomMode"),
        ctx.storage.get("roomId"),
        ctx.storage.get("idleDeadline"),
        ctx.storage.get("processedActions")
      ]);
      if (snapshot) this.game.restore(snapshot);
      if (sessions) this.sessions = sessions;
      if (bots) this.botIds = bots;
      if (mode) this.roomMode = mode;
      if (roomId) this.roomId = roomId;
      if (idleDeadline) this.idleDeadline = idleDeadline;
      if (processedActions) this.processedActions = processedActions;
    });
    this.game.onPenalty = (playerId, reason) => {
      for (const socket of this.ctx.getWebSockets()) {
        emit(socket, "penalty", { playerId, reason });
        if (socket.deserializeAttachment()?.playerId === playerId) {
          emit(socket, "penaltyAwarded", { reason });
        }
      }
    };
  }
  async fetch(request) {
    const id = new URL(request.url).searchParams.get("room");
    if (id && /^[A-Za-z0-9_-]{1,48}$/.test(id) && id !== this.roomId) {
      this.roomId = id;
      await this.ctx.storage.put("roomId", id);
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({});
    return new Response(null, { status: 101, webSocket: client });
  }
  broadcastDrawReveal(event) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN && socket.deserializeAttachment()?.playerId) {
        emit(socket, "cardDrawReveal", event);
      }
    }
  }
  broadcast() {
    for (const socket of this.ctx.getWebSockets()) {
      const playerId = socket.deserializeAttachment()?.playerId;
      if (playerId) {
        const view = visibleState(this.game.state, playerId);
        view.hostId = this.currentHostId();
        if (this.game.state.phase === "PENALTY_DISTRIBUTION") {
          view.pendingPenaltyDebts = this.game.snapshot().penaltyDebts;
          view.pendingPenaltyTurn = this.game.currentPenaltyTurn();
        }
        emit(socket, "gameStateUpdate", view);
      }
    }
  }
  currentHostId() {
    const active = new Set(this.activePlayerIds());
    return this.game.state.players.find((p) => active.has(p.id) && !p.isBot)?.id;
  }
  async forgetLobbySeat(socket) {
    if (this.game.state.phase !== "LOBBY") return;
    const id = socket.deserializeAttachment()?.playerId;
    if (!id || this.activePlayerIds(socket).includes(id)) return;
    this.game.state.players = this.game.state.players.filter((p) => p.id !== id);
    for (const [token, session] of Object.entries(this.sessions)) {
      if (session.playerId === id) delete this.sessions[token];
    }
    await Promise.all([
      this.ctx.storage.put("sessions", this.sessions),
      this.saveGame()
    ]);
    this.broadcast();
  }
  activePlayerIds(exclude) {
    const ids = /* @__PURE__ */ new Set();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude || socket.readyState !== WebSocket.OPEN) continue;
      const id = socket.deserializeAttachment()?.playerId;
      if (id) ids.add(id);
    }
    return [...ids];
  }
  async reportRoom() {
    if (!this.roomId || this.roomMode === "bot") return;
    const ids = new Set(this.activePlayerIds());
    const players = this.game.state.players.filter((p) => ids.has(p.id)).map((p) => p.name);
    try {
      await this.env.LOBBY.getByName("public-tables").fetch("https://lobby.internal/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: this.roomId, players, phase: this.game.state.phase })
      });
    } catch (e) {
      console.warn("Lobby sync error", String(e).slice(0, 150));
    }
  }
  async clearVacantRoom() {
    if (this.activePlayerIds().length > 0) return;
    if (this.roomId) {
      try {
        await this.env.LOBBY.getByName("public-tables").fetch("https://lobby.internal/remove", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: this.roomId })
        });
      } catch (e) {
        console.warn("Lobby cleanup error", String(e).slice(0, 150));
      }
    }
    const penaltyCallback = this.game.onPenalty;
    this.game = new PidorGame([]);
    this.game.onPenalty = penaltyCallback;
    this.sessions = {};
    this.botIds = [];
    this.roomMode = "friends";
    this.idleDeadline = 0;
    this.processedActions = {};
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
  async markActivity() {
    if (this.activePlayerIds().length) {
      if (this.idleDeadline) {
        this.idleDeadline = 0;
        await this.ctx.storage.delete("idleDeadline");
      }
    } else {
      this.idleDeadline = Date.now() + 75e3;
      await this.ctx.storage.put("idleDeadline", this.idleDeadline);
    }
    await this.driveBots();
  }
  async saveGame() {
    await Promise.all([
      this.ctx.storage.put("game", this.game.snapshot()),
      this.ctx.storage.put("processedActions", this.processedActions)
    ]);
  }
  broadcastVerdict(accuserId, verdict) {
    for (const socket of this.ctx.getWebSockets()) {
      emit(socket, "accusationVerdict", { accuserId, ...verdict });
    }
  }
  announcePenaltyCard(receiverId, giverId) {
    for (const socket of this.ctx.getWebSockets()) {
      const connection = socket.deserializeAttachment();
      if (connection?.playerId === receiverId) {
        emit(socket, "penaltyCardReceived", { giverId });
      }
    }
  }
  async driveBots() {
    if (this.game.state.phase === "DEALING" && this.game.state.initialDealEndsAt && Date.now() < this.game.state.initialDealEndsAt) {
      if (this.roomMode === "bot") await this.ctx.storage.setAlarm(this.game.state.initialDealEndsAt);
      return;
    }
    if (this.idleDeadline && this.activePlayerIds().length === 0) {
      await this.ctx.storage.setAlarm(this.idleDeadline);
      return;
    }
    if (this.game.state.phase === "PENALTY_REVIEW" && this.game.reviewDeadlineAt) {
      await this.ctx.storage.setAlarm(this.game.reviewDeadlineAt);
      return;
    }
    if (this.roomMode !== "bot") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (nextBotMove(this.game, this.botIds)) {
      await this.ctx.storage.setAlarm(Date.now() + 850);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
  async alarm() {
    if (this.game.state.phase === "DEALING" && this.game.state.initialDealEndsAt && Date.now() < this.game.state.initialDealEndsAt) {
      await this.ctx.storage.setAlarm(this.game.state.initialDealEndsAt);
      return;
    }
    if (this.idleDeadline && this.activePlayerIds().length === 0) {
      if (Date.now() >= this.idleDeadline) await this.clearVacantRoom();
      else await this.ctx.storage.setAlarm(this.idleDeadline);
      return;
    }
    if (this.game.expireReview()) {
      await this.saveGame();
      this.broadcast();
      await this.driveBots();
      return;
    }
    if (this.roomMode !== "bot") return;
    const move = nextBotMove(this.game, this.botIds);
    if (!move) {
      await this.driveBots();
      return;
    }
    const drawBefore = move.type === "drawCardFromDeck" ? this.game.state.deck.length : 0;
    const drawnTop = move.type === "drawCardFromDeck" ? this.game.state.deck[drawBefore - 1] : void 0;
    const verdict = move.type === "accuse" ? this.game.accuse(move.actorId, move.accusedId) : null;
    const applied = move.type === "accuse" ? verdict !== null : applyBotMove(this.game, move);
    if (applied) {
      if (move.type === "drawCardFromDeck") {
        const reveal = createDrawReveal(move.actorId, drawnTop, drawBefore, this.game.state.deck.length);
        if (reveal) this.broadcastDrawReveal(reveal);
      }
      if (verdict) this.broadcastVerdict(move.actorId, verdict);
      if (move.type === "givePenaltyCard") this.announcePenaltyCard(move.receiverId, move.actorId);
      await this.saveGame();
      this.broadcast();
    } else {
      console.warn("Bot move rejected", move.type, this.game.state.phase);
    }
    await this.driveBots();
  }
  async join(socket, payload) {
    const tgData = typeof payload.initData === "string" ? payload.initData : "";
    const telegram = tgData ? await verifyTelegram(tgData, this.env.TELEGRAM_BOT_TOKEN) : null;
    if (tgData && !telegram) return emit(socket, "joinError", "Telegram: \u0430\u0432\u0442\u043E\u0440\u0438\u0437\u0430\u0446\u0438\u044F \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430");
    const rawName = telegram ? telegram.first_name || telegram.username : payload.playerName;
    if (typeof rawName !== "string" || !rawName.trim() || rawName.length > 32) {
      return emit(socket, "joinError", "\u0412\u0432\u0435\u0434\u0438 \u0438\u043C\u044F \u043E\u0442 1 \u0434\u043E 32 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432");
    }
    const existingToken = typeof payload.sessionToken === "string" ? payload.sessionToken : "";
    let session = existingToken ? this.sessions[existingToken] : void 0;
    if (session && session.telegramId !== void 0 && session.telegramId !== telegram?.id) {
      return emit(socket, "joinError", "\u0421\u0435\u0441\u0441\u0438\u044F \u043F\u0440\u0438\u043D\u0430\u0434\u043B\u0435\u0436\u0438\u0442 \u0434\u0440\u0443\u0433\u043E\u043C\u0443 \u0438\u0433\u0440\u043E\u043A\u0443 Telegram");
    }
    let token = existingToken;
    let createdBotRoom = false;
    if (!session && this.game.state.phase !== "LOBBY" && this.activePlayerIds(socket).length === 0 && (!this.idleDeadline || Date.now() >= this.idleDeadline)) {
      await this.clearVacantRoom();
    }
    if (!session) {
      if (this.game.state.players.length === 0) {
        let useBase = payload.underlaidCards !== false;
        if (payload.mode !== "bot" && this.roomId) {
          try {
            const response = await this.env.LOBBY.getByName("public-tables").fetch(
              "https://lobby.internal/get?id=" + encodeURIComponent(this.roomId)
            );
            if (response.ok) {
              const record = await response.json();
              useBase = record.table?.underlaidCards !== false;
            }
          } catch {
          }
        }
        this.game.state.underlaidCards = useBase;
      }
      if (this.roomMode === "bot" && this.game.state.players.length) {
        return emit(socket, "joinError", "\u042D\u0442\u043E \u043E\u0434\u0438\u043D\u043E\u0447\u043D\u0430\u044F \u0438\u0433\u0440\u0430. \u0421\u043E\u0437\u0434\u0430\u0439 \u0441\u0432\u043E\u044E \u043A\u043E\u043C\u043D\u0430\u0442\u0443 \u0441 \u0431\u043E\u0442\u043E\u043C.");
      }
      if (this.game.state.phase !== "LOBBY") return emit(socket, "joinError", "\u041F\u0430\u0440\u0442\u0438\u044F \u0443\u0436\u0435 \u0438\u0434\u0451\u0442 \u2014 \u043F\u0440\u0438\u0441\u043E\u0435\u0434\u0438\u043D\u0438\u0442\u044C\u0441\u044F \u043D\u0435\u043B\u044C\u0437\u044F");
      if (this.game.state.players.length >= 6) return emit(socket, "joinError", "\u041A\u043E\u043C\u043D\u0430\u0442\u0430 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u0430");
      token = crypto.randomUUID();
      session = { playerId: crypto.randomUUID(), name: rawName.trim(), telegramId: telegram?.id };
      this.sessions[token] = session;
      this.game.state.players.push({
        id: session.playerId,
        name: session.name,
        hand: [],
        stumps: [],
        penalties: 0,
        isReady: false,
        onDuty: false,
        hasExited: false
      });
      if (this.game.state.players.length === 1 && payload.mode === "bot") {
        this.roomMode = "bot";
        createdBotRoom = true;
        const requested = typeof payload.botCount === "number" ? payload.botCount : 1;
        const count = Math.max(1, Math.min(5, Math.floor(requested || 1)));
        for (let n = 0; n < count; n++) {
          const id = "bot-" + crypto.randomUUID();
          this.botIds.push(id);
          this.game.state.players.push({
            id,
            name: count === 1 ? "\u0411\u043E\u0442 \u0412\u0430\u043B\u0435\u0442" : "\u0411\u043E\u0442 " + (n + 1),
            hand: [],
            stumps: [],
            penalties: 0,
            isReady: true,
            onDuty: false,
            hasExited: false,
            isBot: true
          });
        }
      }
      this.game.state.mode = this.roomMode;
      await Promise.all([
        this.ctx.storage.put("sessions", this.sessions),
        this.ctx.storage.put("bots", this.botIds),
        this.ctx.storage.put("roomMode", this.roomMode)
      ]);
      await this.saveGame();
    }
    for (const other of this.ctx.getWebSockets()) {
      if (other !== socket && other.deserializeAttachment()?.playerId === session.playerId) {
        other.close(1e3, "Reconnected in another tab");
      }
    }
    socket.serializeAttachment({ playerId: session.playerId });
    this.idleDeadline = 0;
    await this.ctx.storage.delete("idleDeadline");
    emit(socket, "joined", { playerId: session.playerId, sessionToken: token, name: session.name });
    if (createdBotRoom) {
      this.game.start();
      await this.saveGame();
    }
    this.broadcast();
    await this.reportRoom();
    await this.driveBots();
  }
  async webSocketMessage(socket, message) {
    if (typeof message !== "string" || message.length > 8192) return;
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    const type = parsed.type;
    const data = parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? parsed.data : {};
    if (type === "joinRoom") {
      await this.join(socket, data);
      return;
    }
    if (type === "ping") {
      emit(socket, "pong", Date.now());
      await this.reportRoom();
      return;
    }
    const id = socket.deserializeAttachment()?.playerId;
    if (!id || !this.game.state.players.some((p) => p.id === id)) {
      return emit(socket, "joinError", "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0441\u044C \u043A \u043A\u043E\u043C\u043D\u0430\u0442\u0435");
    }
    const game = this.game;
    if (game.state.phase === "DEALING" && game.state.initialDealEndsAt && Date.now() < game.state.initialDealEndsAt && ["drawTo", "moveTopTo", "drawCardFromDeck", "takeFromPile", "placeActiveCard"].includes(type || "")) {
      return emit(socket, "actionError", "\u0418\u0434\u0451\u0442 \u043D\u0430\u0447\u0430\u043B\u044C\u043D\u0430\u044F \u0440\u0430\u0437\u0434\u0430\u0447\u0430");
    }
    if (type && STATE_CHANGING_ACTIONS.has(type) && data.actionId !== void 0) {
      if (typeof data.actionId !== "string" || !rememberAction(this.processedActions, id, data.actionId)) {
        return emit(socket, "actionError", "\u041F\u043E\u0432\u0442\u043E\u0440\u043D\u043E\u0435 \u0438\u043B\u0438 \u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u043E\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435");
      }
    }
    if (type === "accusePlayer" && typeof data.accusedId === "string") {
      const verdict = game.accuse(id, data.accusedId);
      console.info("[PIDOR-ACCUSATION]", verdict ? verdict.correct ? "confirmed" : "false-call" : "rejected", game.state.phase);
      if (verdict) this.broadcastVerdict(id, verdict);
      else emit(socket, "actionError", "\u041E\u0431\u0432\u0438\u043D\u0435\u043D\u0438\u0435 \u0441\u0435\u0439\u0447\u0430\u0441 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E");
    } else if (type === "finishReview") {
      if (!game.finishReview(id)) emit(socket, "actionError", "\u0420\u0430\u0437\u0431\u043E\u0440 \u0443\u0436\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D");
    } else if (type === "startGame") {
      if (game.state.phase !== "LOBBY" || game.state.players.length < 2) {
        emit(socket, "actionError", "\u041D\u0435\u0434\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u043E \u0438\u0433\u0440\u043E\u043A\u043E\u0432 \u0438\u043B\u0438 \u043F\u0430\u0440\u0442\u0438\u044F \u0443\u0436\u0435 \u043D\u0430\u0447\u0430\u043B\u0430\u0441\u044C");
      } else if (this.currentHostId() !== id) {
        emit(socket, "actionError", "\u041F\u0430\u0440\u0442\u0438\u044E \u043D\u0430\u0447\u0438\u043D\u0430\u0435\u0442 \u0432\u0435\u0434\u0443\u0449\u0438\u0439 \u0441\u0442\u043E\u043B\u0430");
      } else game.start();
    } else if (type === "drawTo" && typeof data.targetPlayerId === "string") {
      const before = game.state.deck.length;
      const card = game.state.deck[before - 1];
      game.drawTo(id, data.targetPlayerId);
      const reveal = createDrawReveal(id, card, before, game.state.deck.length, data.targetPlayerId);
      if (reveal) this.broadcastDrawReveal(reveal);
    } else if (type === "moveTopTo" && typeof data.targetPlayerId === "string") game.moveTopTo(id, data.targetPlayerId);
    else if (type === "drawCardFromDeck") {
      const before = game.state.deck.length;
      const card = game.state.deck[before - 1];
      game.takeFromDeck(id);
      const reveal = createDrawReveal(id, card, before, game.state.deck.length);
      if (reveal) this.broadcastDrawReveal(reveal);
    } else if (type === "takeFromPile" && typeof data.cardId === "string") game.takeFromPile(id, data.cardId);
    else if (type === "placeActiveCard" && typeof data.targetPlayerId === "string") game.placeActiveCard(id, data.targetPlayerId);
    else if (type === "givePenaltyCard" && typeof data.cardId === "string" && typeof data.receiverId === "string") {
      if (game.givePenaltyCard(id, data.cardId, data.receiverId)) {
        this.announcePenaltyCard(data.receiverId, id);
      }
    } else if (type === "playCard" && typeof data.cardId === "string") game.playCard(id, data.cardId);
    else if (type === "takeTrick") game.takeTrick(id);
    else if (type === "takeStumps") game.takeStumps(id);
    else if (type === "exitGame") game.exitGame(id);
    else if (type === "sayPhrase" && typeof data.phrase === "string" && data.phrase.length <= 120) {
      for (const other of this.ctx.getWebSockets()) emit(other, "playerMessage", { playerId: id, message: data.phrase });
      return;
    } else return;
    await this.saveGame();
    this.broadcast();
    if (type === "startGame" || type === "exitGame") await this.reportRoom();
    await this.driveBots();
  }
  async webSocketClose(socket, code, reason) {
    try {
      socket.close(code, reason);
    } catch {
    }
    await this.forgetLobbySeat(socket);
    await this.reportRoom();
    await this.markActivity();
  }
  async webSocketError(socket) {
    try {
      socket.close(1011, "WebSocket error");
    } catch {
    }
    await this.forgetLobbySeat(socket);
    await this.reportRoom();
    await this.markActivity();
  }
};
// PIDOR ONLINE P3/P4 frontend release: same-origin /api/app, safe for legacy assets.
const RELEASE_HTML = "<!doctype html>\n<html lang=\"ru\">\n<head>\n  <meta charset=\"UTF-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=5.0\" />\n  <meta name=\"theme-color\" content=\"#0b1718\" />\n  <meta name=\"description\" content=\"PIDOR ONLINE — карточная игра на 36 карт для друзей и ботов в Telegram.\" />\n  <link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2315352d'/%3E%3Ctext x='32' y='46' font-size='43' font-weight='bold' text-anchor='middle' fill='%23e9bd79'%3EP%3C/text%3E%3C/svg%3E\" />\n  <title>PIDOR ONLINE — Карточная игра</title>\n  <script src=\"https://telegram.org/js/telegram-web-app.js\"></script>\n  <script type=\"module\" src=\"/api/app.js\"></script>\n  <link rel=\"stylesheet\" href=\"/api/app.css\">\n</head>\n<body>\n  <div id=\"app\"></div>\n</body>\n</html>\n";
const RELEASE_JS = "(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel=\"modulepreload\"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin===`use-credentials`?t.credentials=`include`:e.crossOrigin===`anonymous`?t.credentials=`omit`:t.credentials=`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();function e(e){let t=Object.create(null);for(let n of e.split(`,`))t[n]=1;return e=>e in t}var t={},n=[],r=()=>{},i=()=>!1,a=e=>e.charCodeAt(0)===111&&e.charCodeAt(1)===110&&(e.charCodeAt(2)>122||e.charCodeAt(2)<97),o=e=>e.startsWith(`onUpdate:`),s=Object.assign,c=(e,t)=>{let n=e.indexOf(t);n>-1&&e.splice(n,1)},l=Object.prototype.hasOwnProperty,u=(e,t)=>l.call(e,t),d=Array.isArray,f=e=>x(e)===`[object Map]`,p=e=>x(e)===`[object Set]`,m=e=>x(e)===`[object Date]`,h=e=>typeof e==`function`,g=e=>typeof e==`string`,_=e=>typeof e==`symbol`,v=e=>typeof e==`object`&&!!e,y=e=>(v(e)||h(e))&&h(e.then)&&h(e.catch),b=Object.prototype.toString,x=e=>b.call(e),S=e=>x(e).slice(8,-1),C=e=>x(e)===`[object Object]`,w=e=>g(e)&&e!==`NaN`&&e[0]!==`-`&&``+parseInt(e,10)===e,T=e(`,key,ref,ref_for,ref_key,onVnodeBeforeMount,onVnodeMounted,onVnodeBeforeUpdate,onVnodeUpdated,onVnodeBeforeUnmount,onVnodeUnmounted`),ee=e=>{let t=Object.create(null);return(n=>t[n]||(t[n]=e(n)))},E=/-\\w/g,D=ee(e=>e.replace(E,e=>e.slice(1).toUpperCase())),O=/\\B([A-Z])/g,k=ee(e=>e.replace(O,`-$1`).toLowerCase()),te=ee(e=>e.charAt(0).toUpperCase()+e.slice(1)),A=ee(e=>e?`on${te(e)}`:``),ne=(e,t)=>!Object.is(e,t),re=(e,...t)=>{for(let n=0;n<e.length;n++)e[n](...t)},j=(e,t,n,r=!1)=>{Object.defineProperty(e,t,{configurable:!0,enumerable:!1,writable:r,value:n})},ie=e=>{let t=parseFloat(e);return isNaN(t)?e:t},ae=e=>{let t=g(e)?Number(e):NaN;return isNaN(t)?e:t},oe,se=()=>oe||=typeof globalThis<`u`?globalThis:typeof self<`u`?self:typeof window<`u`?window:typeof global<`u`?global:{};function M(e){if(d(e)){let t={};for(let n=0;n<e.length;n++){let r=e[n],i=g(r)?de(r):M(r);if(i)for(let e in i)t[e]=i[e]}return t}else if(g(e)||v(e))return e}var ce=/;(?![^(]*\\))/g,le=/:([^]+)/,ue=/\\/\\*[^]*?\\*\\//g;function de(e){let t={};return e.replace(ue,``).split(ce).forEach(e=>{if(e){let n=e.split(le);n.length>1&&(t[n[0].trim()]=n[1].trim())}}),t}function N(e){let t=``;if(g(e))t=e;else if(d(e))for(let n=0;n<e.length;n++){let r=N(e[n]);r&&(t+=r+` `)}else if(v(e))for(let n in e)e[n]&&(t+=n+` `);return t.trim()}var fe=`itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,readonly`,pe=e(fe);fe+``;function me(e){return!!e||e===``}function he(e,t){if(e.length!==t.length)return!1;let n=!0;for(let r=0;n&&r<e.length;r++)n=P(e[r],t[r]);return n}function P(e,t){if(e===t)return!0;let n=m(e),r=m(t);if(n||r)return n&&r?e.getTime()===t.getTime():!1;if(n=_(e),r=_(t),n||r)return e===t;if(n=d(e),r=d(t),n||r)return n&&r?he(e,t):!1;if(n=v(e),r=v(t),n||r){if(!n||!r||Object.keys(e).length!==Object.keys(t).length)return!1;for(let n in e){let r=e.hasOwnProperty(n),i=t.hasOwnProperty(n);if(r&&!i||!r&&i||!P(e[n],t[n]))return!1}}return String(e)===String(t)}function F(e,t){return e.findIndex(e=>P(e,t))}var I=e=>!!(e&&e.__v_isRef===!0),L=e=>g(e)?e:e==null?``:d(e)||v(e)&&(e.toString===b||!h(e.toString))?I(e)?L(e.value):JSON.stringify(e,R,2):String(e),R=(e,t)=>I(t)?R(e,t.value):f(t)?{[`Map(${t.size})`]:[...t.entries()].reduce((e,[t,n],r)=>(e[ge(t,r)+` =>`]=n,e),{})}:p(t)?{[`Set(${t.size})`]:[...t.values()].map(e=>ge(e))}:_(t)?ge(t):v(t)&&!d(t)&&!C(t)?String(t):t,ge=(e,t=``)=>_(e)?`Symbol(${e.description??t})`:e,z,_e=class{constructor(e=!1){this.detached=e,this._active=!0,this._on=0,this.effects=[],this.cleanups=[],this._isPaused=!1,this.__v_skip=!0,this.parent=z,!e&&z&&(this.index=(z.scopes||=[]).push(this)-1)}get active(){return this._active}pause(){if(this._active){this._isPaused=!0;let e,t;if(this.scopes)for(e=0,t=this.scopes.length;e<t;e++)this.scopes[e].pause();for(e=0,t=this.effects.length;e<t;e++)this.effects[e].pause()}}resume(){if(this._active&&this._isPaused){this._isPaused=!1;let e,t;if(this.scopes)for(e=0,t=this.scopes.length;e<t;e++)this.scopes[e].resume();for(e=0,t=this.effects.length;e<t;e++)this.effects[e].resume()}}run(e){if(this._active){let t=z;try{return z=this,e()}finally{z=t}}}on(){++this._on===1&&(this.prevScope=z,z=this)}off(){this._on>0&&--this._on===0&&(z=this.prevScope,this.prevScope=void 0)}stop(e){if(this._active){this._active=!1;let t,n;for(t=0,n=this.effects.length;t<n;t++)this.effects[t].stop();for(this.effects.length=0,t=0,n=this.cleanups.length;t<n;t++)this.cleanups[t]();if(this.cleanups.length=0,this.scopes){for(t=0,n=this.scopes.length;t<n;t++)this.scopes[t].stop(!0);this.scopes.length=0}if(!this.detached&&this.parent&&!e){let e=this.parent.scopes.pop();e&&e!==this&&(this.parent.scopes[this.index]=e,e.index=this.index)}this.parent=void 0}}};function ve(e){return new _e(e)}function ye(){return z}function be(e,t=!1){z&&z.cleanups.push(e)}var B,xe=new WeakSet,Se=class{constructor(e){this.fn=e,this.deps=void 0,this.depsTail=void 0,this.flags=5,this.next=void 0,this.cleanup=void 0,this.scheduler=void 0,z&&z.active&&z.effects.push(this)}pause(){this.flags|=64}resume(){this.flags&64&&(this.flags&=-65,xe.has(this)&&(xe.delete(this),this.trigger()))}notify(){this.flags&2&&!(this.flags&32)||this.flags&8||Ee(this)}run(){if(!(this.flags&1))return this.fn();this.flags|=2,Re(this),ke(this);let e=B,t=Pe;B=this,Pe=!0;try{return this.fn()}finally{Ae(this),B=e,Pe=t,this.flags&=-3}}stop(){if(this.flags&1){for(let e=this.deps;e;e=e.nextDep)Me(e);this.deps=this.depsTail=void 0,Re(this),this.onStop&&this.onStop(),this.flags&=-2}}trigger(){this.flags&64?xe.add(this):this.scheduler?this.scheduler():this.runIfDirty()}runIfDirty(){V(this)&&this.run()}get dirty(){return V(this)}},Ce=0,we,Te;function Ee(e,t=!1){if(e.flags|=8,t){e.next=Te,Te=e;return}e.next=we,we=e}function De(){Ce++}function Oe(){if(--Ce>0)return;if(Te){let e=Te;for(Te=void 0;e;){let t=e.next;e.next=void 0,e.flags&=-9,e=t}}let e;for(;we;){let t=we;for(we=void 0;t;){let n=t.next;if(t.next=void 0,t.flags&=-9,t.flags&1)try{t.trigger()}catch(t){e||=t}t=n}}if(e)throw e}function ke(e){for(let t=e.deps;t;t=t.nextDep)t.version=-1,t.prevActiveLink=t.dep.activeLink,t.dep.activeLink=t}function Ae(e){let t,n=e.depsTail,r=n;for(;r;){let e=r.prevDep;r.version===-1?(r===n&&(n=e),Me(r),Ne(r)):t=r,r.dep.activeLink=r.prevActiveLink,r.prevActiveLink=void 0,r=e}e.deps=t,e.depsTail=n}function V(e){for(let t=e.deps;t;t=t.nextDep)if(t.dep.version!==t.version||t.dep.computed&&(je(t.dep.computed)||t.dep.version!==t.version))return!0;return!!e._dirty}function je(e){if(e.flags&4&&!(e.flags&16)||(e.flags&=-17,e.globalVersion===ze)||(e.globalVersion=ze,!e.isSSR&&e.flags&128&&(!e.deps&&!e._dirty||!V(e))))return;e.flags|=2;let t=e.dep,n=B,r=Pe;B=e,Pe=!0;try{ke(e);let n=e.fn(e._value);(t.version===0||ne(n,e._value))&&(e.flags|=128,e._value=n,t.version++)}catch(e){throw t.version++,e}finally{B=n,Pe=r,Ae(e),e.flags&=-3}}function Me(e,t=!1){let{dep:n,prevSub:r,nextSub:i}=e;if(r&&(r.nextSub=i,e.prevSub=void 0),i&&(i.prevSub=r,e.nextSub=void 0),n.subs===e&&(n.subs=r,!r&&n.computed)){n.computed.flags&=-5;for(let e=n.computed.deps;e;e=e.nextDep)Me(e,!0)}!t&&!--n.sc&&n.map&&n.map.delete(n.key)}function Ne(e){let{prevDep:t,nextDep:n}=e;t&&(t.nextDep=n,e.prevDep=void 0),n&&(n.prevDep=t,e.nextDep=void 0)}var Pe=!0,Fe=[];function Ie(){Fe.push(Pe),Pe=!1}function Le(){let e=Fe.pop();Pe=e===void 0?!0:e}function Re(e){let{cleanup:t}=e;if(e.cleanup=void 0,t){let e=B;B=void 0;try{t()}finally{B=e}}}var ze=0,Be=class{constructor(e,t){this.sub=e,this.dep=t,this.version=t.version,this.nextDep=this.prevDep=this.nextSub=this.prevSub=this.prevActiveLink=void 0}},Ve=class{constructor(e){this.computed=e,this.version=0,this.activeLink=void 0,this.subs=void 0,this.map=void 0,this.key=void 0,this.sc=0,this.__v_skip=!0}track(e){if(!B||!Pe||B===this.computed)return;let t=this.activeLink;if(t===void 0||t.sub!==B)t=this.activeLink=new Be(B,this),B.deps?(t.prevDep=B.depsTail,B.depsTail.nextDep=t,B.depsTail=t):B.deps=B.depsTail=t,He(t);else if(t.version===-1&&(t.version=this.version,t.nextDep)){let e=t.nextDep;e.prevDep=t.prevDep,t.prevDep&&(t.prevDep.nextDep=e),t.prevDep=B.depsTail,t.nextDep=void 0,B.depsTail.nextDep=t,B.depsTail=t,B.deps===t&&(B.deps=e)}return t}trigger(e){this.version++,ze++,this.notify(e)}notify(e){De();try{for(let e=this.subs;e;e=e.prevSub)e.sub.notify()&&e.sub.dep.notify()}finally{Oe()}}};function He(e){if(e.dep.sc++,e.sub.flags&4){let t=e.dep.computed;if(t&&!e.dep.subs){t.flags|=20;for(let e=t.deps;e;e=e.nextDep)He(e)}let n=e.dep.subs;n!==e&&(e.prevSub=n,n&&(n.nextSub=e)),e.dep.subs=e}}var Ue=new WeakMap,We=Symbol(``),Ge=Symbol(``),Ke=Symbol(``);function H(e,t,n){if(Pe&&B){let t=Ue.get(e);t||Ue.set(e,t=new Map);let r=t.get(n);r||(t.set(n,r=new Ve),r.map=t,r.key=n),r.track()}}function qe(e,t,n,r,i,a){let o=Ue.get(e);if(!o){ze++;return}let s=e=>{e&&e.trigger()};if(De(),t===`clear`)o.forEach(s);else{let i=d(e),a=i&&w(n);if(i&&n===`length`){let e=Number(r);o.forEach((t,n)=>{(n===`length`||n===Ke||!_(n)&&n>=e)&&s(t)})}else switch((n!==void 0||o.has(void 0))&&s(o.get(n)),a&&s(o.get(Ke)),t){case`add`:i?a&&s(o.get(`length`)):(s(o.get(We)),f(e)&&s(o.get(Ge)));break;case`delete`:i||(s(o.get(We)),f(e)&&s(o.get(Ge)));break;case`set`:f(e)&&s(o.get(We));break}}Oe()}function Je(e,t){let n=Ue.get(e);return n&&n.get(t)}function Ye(e){let t=U(e);return t===e?t:(H(t,`iterate`,Ke),Ft(e)?t:t.map(Rt))}function Xe(e){return H(e=U(e),`iterate`,Ke),e}function Ze(e,t){return Pt(e)?zt(Nt(e)?Rt(t):t):Rt(t)}var Qe={__proto__:null,[Symbol.iterator](){return $e(this,Symbol.iterator,e=>Ze(this,e))},concat(...e){return Ye(this).concat(...e.map(e=>d(e)?Ye(e):e))},entries(){return $e(this,`entries`,e=>(e[1]=Ze(this,e[1]),e))},every(e,t){return tt(this,`every`,e,t,void 0,arguments)},filter(e,t){return tt(this,`filter`,e,t,e=>e.map(e=>Ze(this,e)),arguments)},find(e,t){return tt(this,`find`,e,t,e=>Ze(this,e),arguments)},findIndex(e,t){return tt(this,`findIndex`,e,t,void 0,arguments)},findLast(e,t){return tt(this,`findLast`,e,t,e=>Ze(this,e),arguments)},findLastIndex(e,t){return tt(this,`findLastIndex`,e,t,void 0,arguments)},forEach(e,t){return tt(this,`forEach`,e,t,void 0,arguments)},includes(...e){return rt(this,`includes`,e)},indexOf(...e){return rt(this,`indexOf`,e)},join(e){return Ye(this).join(e)},lastIndexOf(...e){return rt(this,`lastIndexOf`,e)},map(e,t){return tt(this,`map`,e,t,void 0,arguments)},pop(){return it(this,`pop`)},push(...e){return it(this,`push`,e)},reduce(e,...t){return nt(this,`reduce`,e,t)},reduceRight(e,...t){return nt(this,`reduceRight`,e,t)},shift(){return it(this,`shift`)},some(e,t){return tt(this,`some`,e,t,void 0,arguments)},splice(...e){return it(this,`splice`,e)},toReversed(){return Ye(this).toReversed()},toSorted(e){return Ye(this).toSorted(e)},toSpliced(...e){return Ye(this).toSpliced(...e)},unshift(...e){return it(this,`unshift`,e)},values(){return $e(this,`values`,e=>Ze(this,e))}};function $e(e,t,n){let r=Xe(e),i=r[t]();return r!==e&&!Ft(e)&&(i._next=i.next,i.next=()=>{let e=i._next();return e.done||(e.value=n(e.value)),e}),i}var et=Array.prototype;function tt(e,t,n,r,i,a){let o=Xe(e),s=o!==e&&!Ft(e),c=o[t];if(c!==et[t]){let t=c.apply(e,a);return s?Rt(t):t}let l=n;o!==e&&(s?l=function(t,r){return n.call(this,Ze(e,t),r,e)}:n.length>2&&(l=function(t,r){return n.call(this,t,r,e)}));let u=c.call(o,l,r);return s&&i?i(u):u}function nt(e,t,n,r){let i=Xe(e),a=n;return i!==e&&(Ft(e)?n.length>3&&(a=function(t,r,i){return n.call(this,t,r,i,e)}):a=function(t,r,i){return n.call(this,t,Ze(e,r),i,e)}),i[t](a,...r)}function rt(e,t,n){let r=U(e);H(r,`iterate`,Ke);let i=r[t](...n);return(i===-1||i===!1)&&It(n[0])?(n[0]=U(n[0]),r[t](...n)):i}function it(e,t,n=[]){Ie(),De();let r=U(e)[t].apply(e,n);return Oe(),Le(),r}var at=e(`__proto__,__v_isRef,__isVue`),ot=new Set(Object.getOwnPropertyNames(Symbol).filter(e=>e!==`arguments`&&e!==`caller`).map(e=>Symbol[e]).filter(_));function st(e){_(e)||(e=String(e));let t=U(this);return H(t,`has`,e),t.hasOwnProperty(e)}var ct=class{constructor(e=!1,t=!1){this._isReadonly=e,this._isShallow=t}get(e,t,n){if(t===`__v_skip`)return e.__v_skip;let r=this._isReadonly,i=this._isShallow;if(t===`__v_isReactive`)return!r;if(t===`__v_isReadonly`)return r;if(t===`__v_isShallow`)return i;if(t===`__v_raw`)return n===(r?i?Et:Tt:i?wt:Ct).get(e)||Object.getPrototypeOf(e)===Object.getPrototypeOf(n)?e:void 0;let a=d(e);if(!r){let e;if(a&&(e=Qe[t]))return e;if(t===`hasOwnProperty`)return st}let o=Reflect.get(e,t,W(e)?e:n);if((_(t)?ot.has(t):at(t))||(r||H(e,`get`,t),i))return o;if(W(o)){let e=a&&w(t)?o:o.value;return r&&v(e)?jt(e):e}return v(o)?r?jt(o):kt(o):o}},lt=class extends ct{constructor(e=!1){super(!1,e)}set(e,t,n,r){let i=e[t],a=d(e)&&w(t);if(!this._isShallow){let e=Pt(i);if(!Ft(n)&&!Pt(n)&&(i=U(i),n=U(n)),!a&&W(i)&&!W(n))return e||(i.value=n),!0}let o=a?Number(t)<e.length:u(e,t),s=Reflect.set(e,t,n,W(e)?e:r);return e===U(r)&&(o?ne(n,i)&&qe(e,`set`,t,n,i):qe(e,`add`,t,n)),s}deleteProperty(e,t){let n=u(e,t),r=e[t],i=Reflect.deleteProperty(e,t);return i&&n&&qe(e,`delete`,t,void 0,r),i}has(e,t){let n=Reflect.has(e,t);return(!_(t)||!ot.has(t))&&H(e,`has`,t),n}ownKeys(e){return H(e,`iterate`,d(e)?`length`:We),Reflect.ownKeys(e)}},ut=class extends ct{constructor(e=!1){super(!0,e)}set(e,t){return!0}deleteProperty(e,t){return!0}},dt=new lt,ft=new ut,pt=new lt(!0),mt=e=>e,ht=e=>Reflect.getPrototypeOf(e);function gt(e,t,n){return function(...r){let i=this.__v_raw,a=U(i),o=f(a),c=e===`entries`||e===Symbol.iterator&&o,l=e===`keys`&&o,u=i[e](...r),d=n?mt:t?zt:Rt;return!t&&H(a,`iterate`,l?Ge:We),s(Object.create(u),{next(){let{value:e,done:t}=u.next();return t?{value:e,done:t}:{value:c?[d(e[0]),d(e[1])]:d(e),done:t}}})}}function _t(e){return function(...t){return e===`delete`?!1:e===`clear`?void 0:this}}function vt(e,t){let n={get(n){let r=this.__v_raw,i=U(r),a=U(n);e||(ne(n,a)&&H(i,`get`,n),H(i,`get`,a));let{has:o}=ht(i),s=t?mt:e?zt:Rt;if(o.call(i,n))return s(r.get(n));if(o.call(i,a))return s(r.get(a));r!==i&&r.get(n)},get size(){let t=this.__v_raw;return!e&&H(U(t),`iterate`,We),t.size},has(t){let n=this.__v_raw,r=U(n),i=U(t);return e||(ne(t,i)&&H(r,`has`,t),H(r,`has`,i)),t===i?n.has(t):n.has(t)||n.has(i)},forEach(n,r){let i=this,a=i.__v_raw,o=U(a),s=t?mt:e?zt:Rt;return!e&&H(o,`iterate`,We),a.forEach((e,t)=>n.call(r,s(e),s(t),i))}};return s(n,e?{add:_t(`add`),set:_t(`set`),delete:_t(`delete`),clear:_t(`clear`)}:{add(e){!t&&!Ft(e)&&!Pt(e)&&(e=U(e));let n=U(this);return ht(n).has.call(n,e)||(n.add(e),qe(n,`add`,e,e)),this},set(e,n){!t&&!Ft(n)&&!Pt(n)&&(n=U(n));let r=U(this),{has:i,get:a}=ht(r),o=i.call(r,e);o||=(e=U(e),i.call(r,e));let s=a.call(r,e);return r.set(e,n),o?ne(n,s)&&qe(r,`set`,e,n,s):qe(r,`add`,e,n),this},delete(e){let t=U(this),{has:n,get:r}=ht(t),i=n.call(t,e);i||=(e=U(e),n.call(t,e));let a=r?r.call(t,e):void 0,o=t.delete(e);return i&&qe(t,`delete`,e,void 0,a),o},clear(){let e=U(this),t=e.size!==0,n=e.clear();return t&&qe(e,`clear`,void 0,void 0,void 0),n}}),[`keys`,`values`,`entries`,Symbol.iterator].forEach(r=>{n[r]=gt(r,e,t)}),n}function yt(e,t){let n=vt(e,t);return(t,r,i)=>r===`__v_isReactive`?!e:r===`__v_isReadonly`?e:r===`__v_raw`?t:Reflect.get(u(n,r)&&r in t?n:t,r,i)}var bt={get:yt(!1,!1)},xt={get:yt(!1,!0)},St={get:yt(!0,!1)},Ct=new WeakMap,wt=new WeakMap,Tt=new WeakMap,Et=new WeakMap;function Dt(e){switch(e){case`Object`:case`Array`:return 1;case`Map`:case`Set`:case`WeakMap`:case`WeakSet`:return 2;default:return 0}}function Ot(e){return e.__v_skip||!Object.isExtensible(e)?0:Dt(S(e))}function kt(e){return Pt(e)?e:Mt(e,!1,dt,bt,Ct)}function At(e){return Mt(e,!1,pt,xt,wt)}function jt(e){return Mt(e,!0,ft,St,Tt)}function Mt(e,t,n,r,i){if(!v(e)||e.__v_raw&&!(t&&e.__v_isReactive))return e;let a=Ot(e);if(a===0)return e;let o=i.get(e);if(o)return o;let s=new Proxy(e,a===2?r:n);return i.set(e,s),s}function Nt(e){return Pt(e)?Nt(e.__v_raw):!!(e&&e.__v_isReactive)}function Pt(e){return!!(e&&e.__v_isReadonly)}function Ft(e){return!!(e&&e.__v_isShallow)}function It(e){return e?!!e.__v_raw:!1}function U(e){let t=e&&e.__v_raw;return t?U(t):e}function Lt(e){return!u(e,`__v_skip`)&&Object.isExtensible(e)&&j(e,`__v_skip`,!0),e}var Rt=e=>v(e)?kt(e):e,zt=e=>v(e)?jt(e):e;function W(e){return e?e.__v_isRef===!0:!1}function G(e){return Bt(e,!1)}function Bt(e,t){return W(e)?e:new Vt(e,t)}var Vt=class{constructor(e,t){this.dep=new Ve,this.__v_isRef=!0,this.__v_isShallow=!1,this._rawValue=t?e:U(e),this._value=t?e:Rt(e),this.__v_isShallow=t}get value(){return this.dep.track(),this._value}set value(e){let t=this._rawValue,n=this.__v_isShallow||Ft(e)||Pt(e);e=n?e:U(e),ne(e,t)&&(this._rawValue=e,this._value=n?e:Rt(e),this.dep.trigger())}};function K(e){return W(e)?e.value:e}var Ht={get:(e,t,n)=>t===`__v_raw`?e:K(Reflect.get(e,t,n)),set:(e,t,n,r)=>{let i=e[t];return W(i)&&!W(n)?(i.value=n,!0):Reflect.set(e,t,n,r)}};function Ut(e){return Nt(e)?e:new Proxy(e,Ht)}function Wt(e){let t=d(e)?Array(e.length):{};for(let n in e)t[n]=Kt(e,n);return t}var Gt=class{constructor(e,t,n){this._object=e,this._key=t,this._defaultValue=n,this.__v_isRef=!0,this._value=void 0,this._raw=U(e);let r=!0,i=e;if(!d(e)||!w(String(t)))do r=!It(i)||Ft(i);while(r&&(i=i.__v_raw));this._shallow=r}get value(){let e=this._object[this._key];return this._shallow&&(e=K(e)),this._value=e===void 0?this._defaultValue:e}set value(e){if(this._shallow&&W(this._raw[this._key])){let t=this._object[this._key];if(W(t)){t.value=e;return}}this._object[this._key]=e}get dep(){return Je(this._raw,this._key)}};function Kt(e,t,n){return new Gt(e,t,n)}var qt=class{constructor(e,t,n){this.fn=e,this.setter=t,this._value=void 0,this.dep=new Ve(this),this.__v_isRef=!0,this.deps=void 0,this.depsTail=void 0,this.flags=16,this.globalVersion=ze-1,this.next=void 0,this.effect=this,this.__v_isReadonly=!t,this.isSSR=n}notify(){if(this.flags|=16,!(this.flags&8)&&B!==this)return Ee(this,!0),!0}get value(){let e=this.dep.track();return je(this),e&&(e.version=this.dep.version),this._value}set value(e){this.setter&&this.setter(e)}};function Jt(e,t,n=!1){let r,i;return h(e)?r=e:(r=e.get,i=e.set),new qt(r,i,n)}var Yt={},Xt=new WeakMap,Zt=void 0;function Qt(e,t=!1,n=Zt){if(n){let t=Xt.get(n);t||Xt.set(n,t=[]),t.push(e)}}function $t(e,n,i=t){let{immediate:a,deep:o,once:s,scheduler:l,augmentJob:u,call:f}=i,p=e=>o?e:Ft(e)||o===!1||o===0?en(e,1):en(e),m,g,_,v,y=!1,b=!1;if(W(e)?(g=()=>e.value,y=Ft(e)):Nt(e)?(g=()=>p(e),y=!0):d(e)?(b=!0,y=e.some(e=>Nt(e)||Ft(e)),g=()=>e.map(e=>{if(W(e))return e.value;if(Nt(e))return p(e);if(h(e))return f?f(e,2):e()})):g=h(e)?n?f?()=>f(e,2):e:()=>{if(_){Ie();try{_()}finally{Le()}}let t=Zt;Zt=m;try{return f?f(e,3,[v]):e(v)}finally{Zt=t}}:r,n&&o){let e=g,t=o===!0?1/0:o;g=()=>en(e(),t)}let x=ye(),S=()=>{m.stop(),x&&x.active&&c(x.effects,m)};if(s&&n){let e=n;n=(...t)=>{e(...t),S()}}let C=b?Array(e.length).fill(Yt):Yt,w=e=>{if(!(!(m.flags&1)||!m.dirty&&!e))if(n){let e=m.run();if(o||y||(b?e.some((e,t)=>ne(e,C[t])):ne(e,C))){_&&_();let t=Zt;Zt=m;try{let t=[e,C===Yt?void 0:b&&C[0]===Yt?[]:C,v];C=e,f?f(n,3,t):n(...t)}finally{Zt=t}}}else m.run()};return u&&u(w),m=new Se(g),m.scheduler=l?()=>l(w,!1):w,v=e=>Qt(e,!1,m),_=m.onStop=()=>{let e=Xt.get(m);if(e){if(f)f(e,4);else for(let t of e)t();Xt.delete(m)}},n?a?w(!0):C=m.run():l?l(w.bind(null,!0),!0):m.run(),S.pause=m.pause.bind(m),S.resume=m.resume.bind(m),S.stop=S,S}function en(e,t=1/0,n){if(t<=0||!v(e)||e.__v_skip||(n||=new Map,(n.get(e)||0)>=t))return e;if(n.set(e,t),t--,W(e))en(e.value,t,n);else if(d(e))for(let r=0;r<e.length;r++)en(e[r],t,n);else if(p(e)||f(e))e.forEach(e=>{en(e,t,n)});else if(C(e)){for(let r in e)en(e[r],t,n);for(let r of Object.getOwnPropertySymbols(e))Object.prototype.propertyIsEnumerable.call(e,r)&&en(e[r],t,n)}return e}function tn(e,t,n,r){try{return r?e(...r):e()}catch(e){rn(e,t,n)}}function nn(e,t,n,r){if(h(e)){let i=tn(e,t,n,r);return i&&y(i)&&i.catch(e=>{rn(e,t,n)}),i}if(d(e)){let i=[];for(let a=0;a<e.length;a++)i.push(nn(e[a],t,n,r));return i}}function rn(e,n,r,i=!0){let a=n?n.vnode:null,{errorHandler:o,throwUnhandledErrorInProduction:s}=n&&n.appContext.config||t;if(n){let t=n.parent,i=n.proxy,a=`https://vuejs.org/error-reference/#runtime-${r}`;for(;t;){let n=t.ec;if(n){for(let t=0;t<n.length;t++)if(n[t](e,i,a)===!1)return}t=t.parent}if(o){Ie(),tn(o,null,10,[e,i,a]),Le();return}}an(e,r,a,i,s)}function an(e,t,n,r=!0,i=!1){if(i)throw e;console.error(e)}var on=[],sn=-1,cn=[],ln=null,un=0,dn=Promise.resolve(),fn=null;function pn(e){let t=fn||dn;return e?t.then(this?e.bind(this):e):t}function mn(e){let t=sn+1,n=on.length;for(;t<n;){let r=t+n>>>1,i=on[r],a=bn(i);a<e||a===e&&i.flags&2?t=r+1:n=r}return t}function hn(e){if(!(e.flags&1)){let t=bn(e),n=on[on.length-1];!n||!(e.flags&2)&&t>=bn(n)?on.push(e):on.splice(mn(t),0,e),e.flags|=1,gn()}}function gn(){fn||=dn.then(xn)}function _n(e){d(e)?cn.push(...e):ln&&e.id===-1?ln.splice(un+1,0,e):e.flags&1||(cn.push(e),e.flags|=1),gn()}function vn(e,t,n=sn+1){for(;n<on.length;n++){let t=on[n];if(t&&t.flags&2){if(e&&t.id!==e.uid)continue;on.splice(n,1),n--,t.flags&4&&(t.flags&=-2),t(),t.flags&4||(t.flags&=-2)}}}function yn(e){if(cn.length){let e=[...new Set(cn)].sort((e,t)=>bn(e)-bn(t));if(cn.length=0,ln){ln.push(...e);return}for(ln=e,un=0;un<ln.length;un++){let e=ln[un];e.flags&4&&(e.flags&=-2),e.flags&8||e(),e.flags&=-2}ln=null,un=0}}var bn=e=>e.id==null?e.flags&2?-1:1/0:e.id;function xn(e){try{for(sn=0;sn<on.length;sn++){let e=on[sn];e&&!(e.flags&8)&&(e.flags&4&&(e.flags&=-2),tn(e,e.i,e.i?15:14),e.flags&4||(e.flags&=-2))}}finally{for(;sn<on.length;sn++){let e=on[sn];e&&(e.flags&=-2)}sn=-1,on.length=0,yn(e),fn=null,(on.length||cn.length)&&xn(e)}}var Sn=null,Cn=null;function wn(e){let t=Sn;return Sn=e,Cn=e&&e.type.__scopeId||null,t}function Tn(e,t=Sn,n){if(!t||e._n)return e;let r=(...n)=>{r._d&&Ki(-1);let i=wn(t),a;try{a=e(...n)}finally{wn(i),r._d&&Ki(1)}return a};return r._n=!0,r._c=!0,r._d=!0,r}function En(e,n){if(Sn===null)return e;let r=Da(Sn),i=e.dirs||=[];for(let e=0;e<n.length;e++){let[a,o,s,c=t]=n[e];a&&(h(a)&&(a={mounted:a,updated:a}),a.deep&&en(o),i.push({dir:a,instance:r,value:o,oldValue:void 0,arg:s,modifiers:c}))}return e}function Dn(e,t,n,r){let i=e.dirs,a=t&&t.dirs;for(let o=0;o<i.length;o++){let s=i[o];a&&(s.oldValue=a[o].value);let c=s.dir[r];c&&(Ie(),nn(c,n,8,[e.el,s,e,t]),Le())}}function On(e,t){if(da){let n=da.provides,r=da.parent&&da.parent.provides;r===n&&(n=da.provides=Object.create(r)),n[e]=t}}function kn(e,t,n=!1){let r=fa();if(r||Yr){let i=Yr?Yr._context.provides:r?r.parent==null||r.ce?r.vnode.appContext&&r.vnode.appContext.provides:r.parent.provides:void 0;if(i&&e in i)return i[e];if(arguments.length>1)return n&&h(t)?t.call(r&&r.proxy):t}}function An(){return!!(fa()||Yr)}var jn=Symbol.for(`v-scx`),Mn=()=>kn(jn);function Nn(e,t,n){return Pn(e,t,n)}function Pn(e,n,i=t){let{immediate:a,deep:o,flush:c,once:l}=i,u=s({},i),d=n&&a||!n&&c!==`post`,f;if(va){if(c===`sync`){let e=Mn();f=e.__watcherHandles||=[]}else if(!d){let e=()=>{};return e.stop=r,e.resume=r,e.pause=r,e}}let p=da;u.call=(e,t,n)=>nn(e,p,t,n);let m=!1;c===`post`?u.scheduler=e=>{Ei(e,p&&p.suspense)}:c!==`sync`&&(m=!0,u.scheduler=(e,t)=>{t?e():hn(e)}),u.augmentJob=e=>{n&&(e.flags|=4),m&&(e.flags|=2,p&&(e.id=p.uid,e.i=p))};let h=$t(e,n,u);return va&&(f?f.push(h):d&&h()),h}function Fn(e,t,n){let r=this.proxy,i=g(e)?e.includes(`.`)?In(r,e):()=>r[e]:e.bind(r,r),a;h(t)?a=t:(a=t.handler,n=t);let o=ha(this),s=Pn(i,a.bind(r),n);return o(),s}function In(e,t){let n=t.split(`.`);return()=>{let t=e;for(let e=0;e<n.length&&t;e++)t=t[n[e]];return t}}var Ln=Symbol(`_vte`),Rn=e=>e.__isTeleport,zn=Symbol(`_leaveCb`),Bn=Symbol(`_enterCb`);function Vn(){let e={isMounted:!1,isLeaving:!1,isUnmounting:!1,leavingVNodes:new Map};return hr(()=>{e.isMounted=!0}),vr(()=>{e.isUnmounting=!0}),e}var Hn=[Function,Array],Un={mode:String,appear:Boolean,persisted:Boolean,onBeforeEnter:Hn,onEnter:Hn,onAfterEnter:Hn,onEnterCancelled:Hn,onBeforeLeave:Hn,onLeave:Hn,onAfterLeave:Hn,onLeaveCancelled:Hn,onBeforeAppear:Hn,onAppear:Hn,onAfterAppear:Hn,onAppearCancelled:Hn},Wn=e=>{let t=e.subTree;return t.component?Wn(t.component):t},Gn={name:`BaseTransition`,props:Un,setup(e,{slots:t}){let n=fa(),r=Vn();return()=>{let i=t.default&&$n(t.default(),!0);if(!i||!i.length)return;let a=Kn(i),o=U(e),{mode:s}=o;if(r.isLeaving)return Xn(a);let c=Zn(a);if(!c)return Xn(a);let l=Yn(c,o,r,n,e=>l=e);c.type!==Bi&&Qn(c,l);let u=n.subTree&&Zn(n.subTree);if(u&&u.type!==Bi&&!Xi(u,c)&&Wn(n).type!==Bi){let e=Yn(u,o,r,n);if(Qn(u,e),s===`out-in`&&c.type!==Bi)return r.isLeaving=!0,e.afterLeave=()=>{r.isLeaving=!1,n.job.flags&8||n.update(),delete e.afterLeave,u=void 0},Xn(a);s===`in-out`&&c.type!==Bi?e.delayLeave=(e,t,n)=>{let i=Jn(r,u);i[String(u.key)]=u,e[zn]=()=>{t(),e[zn]=void 0,delete l.delayedLeave,u=void 0},l.delayedLeave=()=>{n(),delete l.delayedLeave,u=void 0}}:u=void 0}else u&&=void 0;return a}}};function Kn(e){let t=e[0];if(e.length>1){for(let n of e)if(n.type!==Bi){t=n;break}}return t}var qn=Gn;function Jn(e,t){let{leavingVNodes:n}=e,r=n.get(t.type);return r||(r=Object.create(null),n.set(t.type,r)),r}function Yn(e,t,n,r,i){let{appear:a,mode:o,persisted:s=!1,onBeforeEnter:c,onEnter:l,onAfterEnter:u,onEnterCancelled:f,onBeforeLeave:p,onLeave:m,onAfterLeave:h,onLeaveCancelled:g,onBeforeAppear:_,onAppear:v,onAfterAppear:y,onAppearCancelled:b}=t,x=String(e.key),S=Jn(n,e),C=(e,t)=>{e&&nn(e,r,9,t)},w=(e,t)=>{let n=t[1];C(e,t),d(e)?e.every(e=>e.length<=1)&&n():e.length<=1&&n()},T={mode:o,persisted:s,beforeEnter(t){let r=c;if(!n.isMounted)if(a)r=_||c;else return;t[zn]&&t[zn](!0);let i=S[x];i&&Xi(e,i)&&i.el[zn]&&i.el[zn](),C(r,[t])},enter(e){let t=l,r=u,i=f;if(!n.isMounted)if(a)t=v||l,r=y||u,i=b||f;else return;let o=!1;e[Bn]=t=>{o||(o=!0,C(t?i:r,[e]),T.delayedLeave&&T.delayedLeave(),e[Bn]=void 0)};let s=e[Bn].bind(null,!1);t?w(t,[e,s]):s()},leave(t,r){let i=String(e.key);if(t[Bn]&&t[Bn](!0),n.isUnmounting)return r();C(p,[t]);let a=!1;t[zn]=n=>{a||(a=!0,r(),C(n?g:h,[t]),t[zn]=void 0,S[i]===e&&delete S[i])};let o=t[zn].bind(null,!1);S[i]=e,m?w(m,[t,o]):o()},clone(e){let a=Yn(e,t,n,r,i);return i&&i(a),a}};return T}function Xn(e){if(sr(e))return e=ta(e),e.children=null,e}function Zn(e){if(!sr(e))return Rn(e.type)&&e.children?Kn(e.children):e;if(e.component)return e.component.subTree;let{shapeFlag:t,children:n}=e;if(n){if(t&16)return n[0];if(t&32&&h(n.default))return n.default()}}function Qn(e,t){e.shapeFlag&6&&e.component?(e.transition=t,Qn(e.component.subTree,t)):e.shapeFlag&128?(e.ssContent.transition=t.clone(e.ssContent),e.ssFallback.transition=t.clone(e.ssFallback)):e.transition=t}function $n(e,t=!1,n){let r=[],i=0;for(let a=0;a<e.length;a++){let o=e[a],s=n==null?o.key:String(n)+String(o.key==null?a:o.key);o.type===q?(o.patchFlag&128&&i++,r=r.concat($n(o.children,t,s))):(t||o.type!==Bi)&&r.push(s==null?o:ta(o,{key:s}))}if(i>1)for(let e=0;e<r.length;e++)r[e].patchFlag=-2;return r}function er(e,t){return h(e)?s({name:e.name},t,{setup:e}):e}function tr(e){e.ids=[e.ids[0]+ e.ids[2]+++`-`,0,0]}function nr(e,t){let n;return!!((n=Object.getOwnPropertyDescriptor(e,t))&&!n.configurable)}var rr=new WeakMap;function ir(e,n,r,a,o=!1){if(d(e)){e.forEach((e,t)=>ir(e,n&&(d(n)?n[t]:n),r,a,o));return}if(or(a)&&!o){a.shapeFlag&512&&a.type.__asyncResolved&&a.component.subTree.component&&ir(e,n,r,a.component.subTree);return}let s=a.shapeFlag&4?Da(a.component):a.el,l=o?null:s,{i:f,r:p}=e,m=n&&n.r,_=f.refs===t?f.refs={}:f.refs,v=f.setupState,y=U(v),b=v===t?i:e=>nr(_,e)?!1:u(y,e),x=(e,t)=>!(t&&nr(_,t));if(m!=null&&m!==p){if(ar(n),g(m))_[m]=null,b(m)&&(v[m]=null);else if(W(m)){let e=n;x(m,e.k)&&(m.value=null),e.k&&(_[e.k]=null)}}if(h(p))tn(p,f,12,[l,_]);else{let t=g(p),n=W(p);if(t||n){let i=()=>{if(e.f){let n=t?b(p)?v[p]:_[p]:x(p)||!e.k?p.value:_[e.k];if(o)d(n)&&c(n,s);else if(d(n))n.includes(s)||n.push(s);else if(t)_[p]=[s],b(p)&&(v[p]=_[p]);else{let t=[s];x(p,e.k)&&(p.value=t),e.k&&(_[e.k]=t)}}else t?(_[p]=l,b(p)&&(v[p]=l)):n&&(x(p,e.k)&&(p.value=l),e.k&&(_[e.k]=l))};if(l){let t=()=>{i(),rr.delete(e)};t.id=-1,rr.set(e,t),Ei(t,r)}else ar(e),i()}}}function ar(e){let t=rr.get(e);t&&(t.flags|=8,rr.delete(e))}se().requestIdleCallback,se().cancelIdleCallback;var or=e=>!!e.type.__asyncLoader,sr=e=>e.type.__isKeepAlive;function cr(e,t){ur(e,`a`,t)}function lr(e,t){ur(e,`da`,t)}function ur(e,t,n=da){let r=e.__wdc||=()=>{let t=n;for(;t;){if(t.isDeactivated)return;t=t.parent}return e()};if(fr(t,r,n),n){let e=n.parent;for(;e&&e.parent;)sr(e.parent.vnode)&&dr(r,t,n,e),e=e.parent}}function dr(e,t,n,r){let i=fr(t,e,r,!0);yr(()=>{c(r[t],i)},n)}function fr(e,t,n=da,r=!1){if(n){let i=n[e]||(n[e]=[]),a=t.__weh||=(...r)=>{Ie();let i=ha(n),a=nn(t,n,e,r);return i(),Le(),a};return r?i.unshift(a):i.push(a),a}}var pr=e=>(t,n=da)=>{(!va||e===`sp`)&&fr(e,(...e)=>t(...e),n)},mr=pr(`bm`),hr=pr(`m`),gr=pr(`bu`),_r=pr(`u`),vr=pr(`bum`),yr=pr(`um`),br=pr(`sp`),xr=pr(`rtg`),Sr=pr(`rtc`);function Cr(e,t=da){fr(`ec`,e,t)}var wr=Symbol.for(`v-ndc`);function Tr(e,t,n,r){let i,a=n&&n[r],o=d(e);if(o||g(e)){let n=o&&Nt(e),r=!1,s=!1;n&&(r=!Ft(e),s=Pt(e),e=Xe(e)),i=Array(e.length);for(let n=0,o=e.length;n<o;n++)i[n]=t(r?s?zt(Rt(e[n])):Rt(e[n]):e[n],n,void 0,a&&a[n])}else if(typeof e==`number`){i=Array(e);for(let n=0;n<e;n++)i[n]=t(n+1,n,void 0,a&&a[n])}else if(v(e))if(e[Symbol.iterator])i=Array.from(e,(e,n)=>t(e,n,void 0,a&&a[n]));else{let n=Object.keys(e);i=Array(n.length);for(let r=0,o=n.length;r<o;r++){let o=n[r];i[r]=t(e[o],o,r,a&&a[r])}}else i=[];return n&&(n[r]=i),i}var Er=e=>e?_a(e)?Da(e):Er(e.parent):null,Dr=s(Object.create(null),{$:e=>e,$el:e=>e.vnode.el,$data:e=>e.data,$props:e=>e.props,$attrs:e=>e.attrs,$slots:e=>e.slots,$refs:e=>e.refs,$parent:e=>Er(e.parent),$root:e=>Er(e.root),$host:e=>e.ce,$emit:e=>e.emit,$options:e=>Ir(e),$forceUpdate:e=>e.f||=()=>{hn(e.update)},$nextTick:e=>e.n||=pn.bind(e.proxy),$watch:e=>Fn.bind(e)}),Or=(e,n)=>e!==t&&!e.__isScriptSetup&&u(e,n),kr={get({_:e},n){if(n===`__v_skip`)return!0;let{ctx:r,setupState:i,data:a,props:o,accessCache:s,type:c,appContext:l}=e;if(n[0]!==`$`){let e=s[n];if(e!==void 0)switch(e){case 1:return i[n];case 2:return a[n];case 4:return r[n];case 3:return o[n]}else if(Or(i,n))return s[n]=1,i[n];else if(a!==t&&u(a,n))return s[n]=2,a[n];else if(u(o,n))return s[n]=3,o[n];else if(r!==t&&u(r,n))return s[n]=4,r[n];else jr&&(s[n]=0)}let d=Dr[n],f,p;if(d)return n===`$attrs`&&H(e.attrs,`get`,``),d(e);if((f=c.__cssModules)&&(f=f[n]))return f;if(r!==t&&u(r,n))return s[n]=4,r[n];if(p=l.config.globalProperties,u(p,n))return p[n]},set({_:e},n,r){let{data:i,setupState:a,ctx:o}=e;return Or(a,n)?(a[n]=r,!0):i!==t&&u(i,n)?(i[n]=r,!0):u(e.props,n)||n[0]===`$`&&n.slice(1)in e?!1:(o[n]=r,!0)},has({_:{data:e,setupState:n,accessCache:r,ctx:i,appContext:a,props:o,type:s}},c){let l;return!!(r[c]||e!==t&&c[0]!==`$`&&u(e,c)||Or(n,c)||u(o,c)||u(i,c)||u(Dr,c)||u(a.config.globalProperties,c)||(l=s.__cssModules)&&l[c])},defineProperty(e,t,n){return n.get==null?u(n,`value`)&&this.set(e,t,n.value,null):e._.accessCache[t]=0,Reflect.defineProperty(e,t,n)}};function Ar(e){return d(e)?e.reduce((e,t)=>(e[t]=null,e),{}):e}var jr=!0;function Mr(e){let t=Ir(e),n=e.proxy,i=e.ctx;jr=!1,t.beforeCreate&&Pr(t.beforeCreate,e,`bc`);let{data:a,computed:o,methods:s,watch:c,provide:l,inject:u,created:f,beforeMount:p,mounted:m,beforeUpdate:g,updated:_,activated:y,deactivated:b,beforeDestroy:x,beforeUnmount:S,destroyed:C,unmounted:w,render:T,renderTracked:ee,renderTriggered:E,errorCaptured:D,serverPrefetch:O,expose:k,inheritAttrs:te,components:A,directives:ne,filters:re}=t;if(u&&Nr(u,i,null),s)for(let e in s){let t=s[e];h(t)&&(i[e]=t.bind(n))}if(a){let t=a.call(n,n);v(t)&&(e.data=kt(t))}if(jr=!0,o)for(let e in o){let t=o[e],a=$({get:h(t)?t.bind(n,n):h(t.get)?t.get.bind(n,n):r,set:!h(t)&&h(t.set)?t.set.bind(n):r});Object.defineProperty(i,e,{enumerable:!0,configurable:!0,get:()=>a.value,set:e=>a.value=e})}if(c)for(let e in c)Fr(c[e],i,n,e);if(l){let e=h(l)?l.call(n):l;Reflect.ownKeys(e).forEach(t=>{On(t,e[t])})}f&&Pr(f,e,`c`);function j(e,t){d(t)?t.forEach(t=>e(t.bind(n))):t&&e(t.bind(n))}if(j(mr,p),j(hr,m),j(gr,g),j(_r,_),j(cr,y),j(lr,b),j(Cr,D),j(Sr,ee),j(xr,E),j(vr,S),j(yr,w),j(br,O),d(k))if(k.length){let t=e.exposed||={};k.forEach(e=>{Object.defineProperty(t,e,{get:()=>n[e],set:t=>n[e]=t,enumerable:!0})})}else e.exposed||={};T&&e.render===r&&(e.render=T),te!=null&&(e.inheritAttrs=te),A&&(e.components=A),ne&&(e.directives=ne),O&&tr(e)}function Nr(e,t,n=r){d(e)&&(e=Vr(e));for(let n in e){let r=e[n],i;i=v(r)?`default`in r?kn(r.from||n,r.default,!0):kn(r.from||n):kn(r),W(i)?Object.defineProperty(t,n,{enumerable:!0,configurable:!0,get:()=>i.value,set:e=>i.value=e}):t[n]=i}}function Pr(e,t,n){nn(d(e)?e.map(e=>e.bind(t.proxy)):e.bind(t.proxy),t,n)}function Fr(e,t,n,r){let i=r.includes(`.`)?In(n,r):()=>n[r];if(g(e)){let n=t[e];h(n)&&Nn(i,n)}else if(h(e))Nn(i,e.bind(n));else if(v(e))if(d(e))e.forEach(e=>Fr(e,t,n,r));else{let r=h(e.handler)?e.handler.bind(n):t[e.handler];h(r)&&Nn(i,r,e)}}function Ir(e){let t=e.type,{mixins:n,extends:r}=t,{mixins:i,optionsCache:a,config:{optionMergeStrategies:o}}=e.appContext,s=a.get(t),c;return s?c=s:!i.length&&!n&&!r?c=t:(c={},i.length&&i.forEach(e=>Lr(c,e,o,!0)),Lr(c,t,o)),v(t)&&a.set(t,c),c}function Lr(e,t,n,r=!1){let{mixins:i,extends:a}=t;a&&Lr(e,a,n,!0),i&&i.forEach(t=>Lr(e,t,n,!0));for(let i in t)if(!(r&&i===`expose`)){let r=Rr[i]||n&&n[i];e[i]=r?r(e[i],t[i]):t[i]}return e}var Rr={data:zr,props:Wr,emits:Wr,methods:Ur,computed:Ur,beforeCreate:Hr,created:Hr,beforeMount:Hr,mounted:Hr,beforeUpdate:Hr,updated:Hr,beforeDestroy:Hr,beforeUnmount:Hr,destroyed:Hr,unmounted:Hr,activated:Hr,deactivated:Hr,errorCaptured:Hr,serverPrefetch:Hr,components:Ur,directives:Ur,watch:Gr,provide:zr,inject:Br};function zr(e,t){return t?e?function(){return s(h(e)?e.call(this,this):e,h(t)?t.call(this,this):t)}:t:e}function Br(e,t){return Ur(Vr(e),Vr(t))}function Vr(e){if(d(e)){let t={};for(let n=0;n<e.length;n++)t[e[n]]=e[n];return t}return e}function Hr(e,t){return e?[...new Set([].concat(e,t))]:t}function Ur(e,t){return e?s(Object.create(null),e,t):t}function Wr(e,t){return e?d(e)&&d(t)?[...new Set([...e,...t])]:s(Object.create(null),Ar(e),Ar(t??{})):t}function Gr(e,t){if(!e)return t;if(!t)return e;let n=s(Object.create(null),e);for(let r in t)n[r]=Hr(e[r],t[r]);return n}function Kr(){return{app:null,config:{isNativeTag:i,performance:!1,globalProperties:{},optionMergeStrategies:{},errorHandler:void 0,warnHandler:void 0,compilerOptions:{}},mixins:[],components:{},directives:{},provides:Object.create(null),optionsCache:new WeakMap,propsCache:new WeakMap,emitsCache:new WeakMap}}var qr=0;function Jr(e,t){return function(n,r=null){h(n)||(n=s({},n)),r!=null&&!v(r)&&(r=null);let i=Kr(),a=new WeakSet,o=[],c=!1,l=i.app={_uid:qr++,_component:n,_props:r,_container:null,_context:i,_instance:null,version:Aa,get config(){return i.config},set config(e){},use(e,...t){return a.has(e)||(e&&h(e.install)?(a.add(e),e.install(l,...t)):h(e)&&(a.add(e),e(l,...t))),l},mixin(e){return i.mixins.includes(e)||i.mixins.push(e),l},component(e,t){return t?(i.components[e]=t,l):i.components[e]},directive(e,t){return t?(i.directives[e]=t,l):i.directives[e]},mount(a,o,s){if(!c){let u=l._ceVNode||Z(n,r);return u.appContext=i,s===!0?s=`svg`:s===!1&&(s=void 0),o&&t?t(u,a):e(u,a,s),c=!0,l._container=a,a.__vue_app__=l,Da(u.component)}},onUnmount(e){o.push(e)},unmount(){c&&(nn(o,l._instance,16),e(null,l._container),delete l._container.__vue_app__)},provide(e,t){return i.provides[e]=t,l},runWithContext(e){let t=Yr;Yr=l;try{return e()}finally{Yr=t}}};return l}}var Yr=null,Xr=(e,t)=>t===`modelValue`||t===`model-value`?e.modelModifiers:e[`${t}Modifiers`]||e[`${D(t)}Modifiers`]||e[`${k(t)}Modifiers`];function Zr(e,n,...r){if(e.isUnmounted)return;let i=e.vnode.props||t,a=r,o=n.startsWith(`update:`),s=o&&Xr(i,n.slice(7));s&&(s.trim&&(a=r.map(e=>g(e)?e.trim():e)),s.number&&(a=r.map(ie)));let c,l=i[c=A(n)]||i[c=A(D(n))];!l&&o&&(l=i[c=A(k(n))]),l&&nn(l,e,6,a);let u=i[c+`Once`];if(u){if(!e.emitted)e.emitted={};else if(e.emitted[c])return;e.emitted[c]=!0,nn(u,e,6,a)}}var Qr=new WeakMap;function $r(e,t,n=!1){let r=n?Qr:t.emitsCache,i=r.get(e);if(i!==void 0)return i;let a=e.emits,o={},c=!1;if(!h(e)){let r=e=>{let n=$r(e,t,!0);n&&(c=!0,s(o,n))};!n&&t.mixins.length&&t.mixins.forEach(r),e.extends&&r(e.extends),e.mixins&&e.mixins.forEach(r)}return!a&&!c?(v(e)&&r.set(e,null),null):(d(a)?a.forEach(e=>o[e]=null):s(o,a),v(e)&&r.set(e,o),o)}function ei(e,t){return!e||!a(t)?!1:(t=t.slice(2).replace(/Once$/,``),u(e,t[0].toLowerCase()+t.slice(1))||u(e,k(t))||u(e,t))}function ti(e){let{type:t,vnode:n,proxy:r,withProxy:i,propsOptions:[a],slots:s,attrs:c,emit:l,render:u,renderCache:d,props:f,data:p,setupState:m,ctx:h,inheritAttrs:g}=e,_=wn(e),v,y;try{if(n.shapeFlag&4){let e=i||r,t=e;v=ra(u.call(t,e,d,f,m,p,h)),y=c}else{let e=t;v=ra(e.length>1?e(f,{attrs:c,slots:s,emit:l}):e(f,null)),y=t.props?c:ni(c)}}catch(t){Hi.length=0,rn(t,e,1),v=Z(Bi)}let b=v;if(y&&g!==!1){let e=Object.keys(y),{shapeFlag:t}=b;e.length&&t&7&&(a&&e.some(o)&&(y=ri(y,a)),b=ta(b,y,!1,!0))}return n.dirs&&(b=ta(b,null,!1,!0),b.dirs=b.dirs?b.dirs.concat(n.dirs):n.dirs),n.transition&&Qn(b,n.transition),v=b,wn(_),v}var ni=e=>{let t;for(let n in e)(n===`class`||n===`style`||a(n))&&((t||={})[n]=e[n]);return t},ri=(e,t)=>{let n={};for(let r in e)(!o(r)||!(r.slice(9)in t))&&(n[r]=e[r]);return n};function ii(e,t,n){let{props:r,children:i,component:a}=e,{props:o,children:s,patchFlag:c}=t,l=a.emitsOptions;if(t.dirs||t.transition)return!0;if(n&&c>=0){if(c&1024)return!0;if(c&16)return r?ai(r,o,l):!!o;if(c&8){let e=t.dynamicProps;for(let t=0;t<e.length;t++){let n=e[t];if(oi(o,r,n)&&!ei(l,n))return!0}}}else return(i||s)&&(!s||!s.$stable)?!0:r===o?!1:r?o?ai(r,o,l):!0:!!o;return!1}function ai(e,t,n){let r=Object.keys(t);if(r.length!==Object.keys(e).length)return!0;for(let i=0;i<r.length;i++){let a=r[i];if(oi(t,e,a)&&!ei(n,a))return!0}return!1}function oi(e,t,n){let r=e[n],i=t[n];return n===`style`&&v(r)&&v(i)?!P(r,i):r!==i}function si({vnode:e,parent:t},n){for(;t;){let r=t.subTree;if(r.suspense&&r.suspense.activeBranch===e&&(r.el=e.el),r===e)(e=t.vnode).el=n,t=t.parent;else break}}var ci={},li=()=>Object.create(ci),ui=e=>Object.getPrototypeOf(e)===ci;function di(e,t,n,r=!1){let i={},a=li();e.propsDefaults=Object.create(null),pi(e,t,i,a);for(let t in e.propsOptions[0])t in i||(i[t]=void 0);n?e.props=r?i:At(i):e.type.props?e.props=i:e.props=a,e.attrs=a}function fi(e,t,n,r){let{props:i,attrs:a,vnode:{patchFlag:o}}=e,s=U(i),[c]=e.propsOptions,l=!1;if((r||o>0)&&!(o&16)){if(o&8){let n=e.vnode.dynamicProps;for(let r=0;r<n.length;r++){let o=n[r];if(ei(e.emitsOptions,o))continue;let d=t[o];if(c)if(u(a,o))d!==a[o]&&(a[o]=d,l=!0);else{let t=D(o);i[t]=mi(c,s,t,d,e,!1)}else d!==a[o]&&(a[o]=d,l=!0)}}}else{pi(e,t,i,a)&&(l=!0);let r;for(let a in s)(!t||!u(t,a)&&((r=k(a))===a||!u(t,r)))&&(c?n&&(n[a]!==void 0||n[r]!==void 0)&&(i[a]=mi(c,s,a,void 0,e,!0)):delete i[a]);if(a!==s)for(let e in a)(!t||!u(t,e))&&(delete a[e],l=!0)}l&&qe(e.attrs,`set`,``)}function pi(e,n,r,i){let[a,o]=e.propsOptions,s=!1,c;if(n)for(let t in n){if(T(t))continue;let l=n[t],d;a&&u(a,d=D(t))?!o||!o.includes(d)?r[d]=l:(c||={})[d]=l:ei(e.emitsOptions,t)||(!(t in i)||l!==i[t])&&(i[t]=l,s=!0)}if(o){let n=U(r),i=c||t;for(let t=0;t<o.length;t++){let s=o[t];r[s]=mi(a,n,s,i[s],e,!u(i,s))}}return s}function mi(e,t,n,r,i,a){let o=e[n];if(o!=null){let e=u(o,`default`);if(e&&r===void 0){let e=o.default;if(o.type!==Function&&!o.skipFactory&&h(e)){let{propsDefaults:a}=i;if(n in a)r=a[n];else{let o=ha(i);r=a[n]=e.call(null,t),o()}}else r=e;i.ce&&i.ce._setProp(n,r)}o[0]&&(a&&!e?r=!1:o[1]&&(r===``||r===k(n))&&(r=!0))}return r}var hi=new WeakMap;function gi(e,r,i=!1){let a=i?hi:r.propsCache,o=a.get(e);if(o)return o;let c=e.props,l={},f=[],p=!1;if(!h(e)){let t=e=>{p=!0;let[t,n]=gi(e,r,!0);s(l,t),n&&f.push(...n)};!i&&r.mixins.length&&r.mixins.forEach(t),e.extends&&t(e.extends),e.mixins&&e.mixins.forEach(t)}if(!c&&!p)return v(e)&&a.set(e,n),n;if(d(c))for(let e=0;e<c.length;e++){let n=D(c[e]);_i(n)&&(l[n]=t)}else if(c)for(let e in c){let t=D(e);if(_i(t)){let n=c[e],r=l[t]=d(n)||h(n)?{type:n}:s({},n),i=r.type,a=!1,o=!0;if(d(i))for(let e=0;e<i.length;++e){let t=i[e],n=h(t)&&t.name;if(n===`Boolean`){a=!0;break}else n===`String`&&(o=!1)}else a=h(i)&&i.name===`Boolean`;r[0]=a,r[1]=o,(a||u(r,`default`))&&f.push(t)}}let m=[l,f];return v(e)&&a.set(e,m),m}function _i(e){return e[0]!==`$`&&!T(e)}var vi=e=>e===`_`||e===`_ctx`||e===`$stable`,yi=e=>d(e)?e.map(ra):[ra(e)],bi=(e,t,n)=>{if(t._n)return t;let r=Tn((...e)=>yi(t(...e)),n);return r._c=!1,r},xi=(e,t,n)=>{let r=e._ctx;for(let n in e){if(vi(n))continue;let i=e[n];if(h(i))t[n]=bi(n,i,r);else if(i!=null){let e=yi(i);t[n]=()=>e}}},Si=(e,t)=>{let n=yi(t);e.slots.default=()=>n},Ci=(e,t,n)=>{for(let r in t)(n||!vi(r))&&(e[r]=t[r])},wi=(e,t,n)=>{let r=e.slots=li();if(e.vnode.shapeFlag&32){let e=t._;e?(Ci(r,t,n),n&&j(r,`_`,e,!0)):xi(t,r)}else t&&Si(e,t)},Ti=(e,n,r)=>{let{vnode:i,slots:a}=e,o=!0,s=t;if(i.shapeFlag&32){let e=n._;e?r&&e===1?o=!1:Ci(a,n,r):(o=!n.$stable,xi(n,a)),s=n}else n&&(Si(e,n),s={default:1});if(o)for(let e in a)!vi(e)&&s[e]==null&&delete a[e]},Ei=Ri;function Di(e){return Oi(e)}function Oi(e,i){let a=se();a.__VUE__=!0;let{insert:o,remove:s,patchProp:c,createElement:l,createText:u,createComment:d,setText:f,setElementText:p,parentNode:m,nextSibling:h,setScopeId:g=r,insertStaticContent:_}=e,v=(e,t,n,r=null,i=null,a=null,o=void 0,s=null,c=!!t.dynamicChildren)=>{if(e===t)return;e&&!Xi(e,t)&&(r=he(e),de(e,i,a,!0),e=null),t.patchFlag===-2&&(c=!1,t.dynamicChildren=null);let{type:l,ref:u,shapeFlag:d}=t;switch(l){case zi:y(e,t,n,r);break;case Bi:b(e,t,n,r);break;case Vi:e??x(t,n,r,o);break;case q:A(e,t,n,r,i,a,o,s,c);break;default:d&1?w(e,t,n,r,i,a,o,s,c):d&6?ne(e,t,n,r,i,a,o,s,c):(d&64||d&128)&&l.process(e,t,n,r,i,a,o,s,c,I)}u!=null&&i?ir(u,e&&e.ref,a,t||e,!t):u==null&&e&&e.ref!=null&&ir(e.ref,null,a,e,!0)},y=(e,t,n,r)=>{if(e==null)o(t.el=u(t.children),n,r);else{let n=t.el=e.el;t.children!==e.children&&f(n,t.children)}},b=(e,t,n,r)=>{e==null?o(t.el=d(t.children||``),n,r):t.el=e.el},x=(e,t,n,r)=>{[e.el,e.anchor]=_(e.children,t,n,r,e.el,e.anchor)},S=({el:e,anchor:t},n,r)=>{let i;for(;e&&e!==t;)i=h(e),o(e,n,r),e=i;o(t,n,r)},C=({el:e,anchor:t})=>{let n;for(;e&&e!==t;)n=h(e),s(e),e=n;s(t)},w=(e,t,n,r,i,a,o,s,c)=>{if(t.type===`svg`?o=`svg`:t.type===`math`&&(o=`mathml`),e==null)ee(t,n,r,i,a,o,s,c);else{let n=e.el&&e.el._isVueCE?e.el:null;try{n&&n._beginPatch(),O(e,t,i,a,o,s,c)}finally{n&&n._endPatch()}}},ee=(e,t,n,r,i,a,s,u)=>{let d,f,{props:m,shapeFlag:h,transition:g,dirs:_}=e;if(d=e.el=l(e.type,a,m&&m.is,m),h&8?p(d,e.children):h&16&&D(e.children,d,null,r,i,ki(e,a),s,u),_&&Dn(e,null,r,`created`),E(d,e,e.scopeId,s,r),m){for(let e in m)e!==`value`&&!T(e)&&c(d,e,null,m[e],a,r);`value`in m&&c(d,`value`,null,m.value,a),(f=m.onVnodeBeforeMount)&&sa(f,r,e)}_&&Dn(e,null,r,`beforeMount`);let v=ji(i,g);v&&g.beforeEnter(d),o(d,t,n),((f=m&&m.onVnodeMounted)||v||_)&&Ei(()=>{f&&sa(f,r,e),v&&g.enter(d),_&&Dn(e,null,r,`mounted`)},i)},E=(e,t,n,r,i)=>{if(n&&g(e,n),r)for(let t=0;t<r.length;t++)g(e,r[t]);if(i){let n=i.subTree;if(t===n||Li(n.type)&&(n.ssContent===t||n.ssFallback===t)){let t=i.vnode;E(e,t,t.scopeId,t.slotScopeIds,i.parent)}}},D=(e,t,n,r,i,a,o,s,c=0)=>{for(let l=c;l<e.length;l++)v(null,e[l]=s?ia(e[l]):ra(e[l]),t,n,r,i,a,o,s)},O=(e,n,r,i,a,o,s)=>{let l=n.el=e.el,{patchFlag:u,dynamicChildren:d,dirs:f}=n;u|=e.patchFlag&16;let m=e.props||t,h=n.props||t,g;if(r&&Ai(r,!1),(g=h.onVnodeBeforeUpdate)&&sa(g,r,n,e),f&&Dn(n,e,r,`beforeUpdate`),r&&Ai(r,!0),(m.innerHTML&&h.innerHTML==null||m.textContent&&h.textContent==null)&&p(l,``),d?k(e.dynamicChildren,d,l,r,i,ki(n,a),o):s||M(e,n,l,null,r,i,ki(n,a),o,!1),u>0){if(u&16)te(l,m,h,r,a);else if(u&2&&m.class!==h.class&&c(l,`class`,null,h.class,a),u&4&&c(l,`style`,m.style,h.style,a),u&8){let e=n.dynamicProps;for(let t=0;t<e.length;t++){let n=e[t],i=m[n],o=h[n];(o!==i||n===`value`)&&c(l,n,i,o,a,r)}}u&1&&e.children!==n.children&&p(l,n.children)}else !s&&d==null&&te(l,m,h,r,a);((g=h.onVnodeUpdated)||f)&&Ei(()=>{g&&sa(g,r,n,e),f&&Dn(n,e,r,`updated`)},i)},k=(e,t,n,r,i,a,o)=>{for(let s=0;s<t.length;s++){let c=e[s],l=t[s];v(c,l,c.el&&(c.type===q||!Xi(c,l)||c.shapeFlag&198)?m(c.el):n,null,r,i,a,o,!0)}},te=(e,n,r,i,a)=>{if(n!==r){if(n!==t)for(let t in n)!T(t)&&!(t in r)&&c(e,t,n[t],null,a,i);for(let t in r){if(T(t))continue;let o=r[t],s=n[t];o!==s&&t!==`value`&&c(e,t,s,o,a,i)}`value`in r&&c(e,`value`,n.value,r.value,a)}},A=(e,t,n,r,i,a,s,c,l)=>{let d=t.el=e?e.el:u(``),f=t.anchor=e?e.anchor:u(``),{patchFlag:p,dynamicChildren:m,slotScopeIds:h}=t;h&&(c=c?c.concat(h):h),e==null?(o(d,n,r),o(f,n,r),D(t.children||[],n,f,i,a,s,c,l)):p>0&&p&64&&m&&e.dynamicChildren&&e.dynamicChildren.length===m.length?(k(e.dynamicChildren,m,n,i,a,s,c),(t.key!=null||i&&t===i.subTree)&&Mi(e,t,!0)):M(e,t,n,f,i,a,s,c,l)},ne=(e,t,n,r,i,a,o,s,c)=>{t.slotScopeIds=s,e==null?t.shapeFlag&512?i.ctx.activate(t,n,r,o,c):j(t,n,r,i,a,o,c):ie(e,t,c)},j=(e,t,n,r,i,a,o)=>{let s=e.component=ua(e,r,i);if(sr(e)&&(s.ctx.renderer=I),ya(s,!1,o),s.asyncDep){if(i&&i.registerDep(s,ae,o),!e.el){let r=s.subTree=Z(Bi);b(null,r,t,n),e.placeholder=r.el}}else ae(s,e,t,n,i,a,o)},ie=(e,t,n)=>{let r=t.component=e.component;if(ii(e,t,n))if(r.asyncDep&&!r.asyncResolved){oe(r,t,n);return}else r.next=t,r.update();else t.el=e.el,r.vnode=t},ae=(e,t,n,r,i,a,o)=>{let s=()=>{if(e.isMounted){let{next:t,bu:n,u:r,parent:s,vnode:c}=e;{let n=Pi(e);if(n){t&&(t.el=c.el,oe(e,t,o)),n.asyncDep.then(()=>{Ei(()=>{e.isUnmounted||l()},i)});return}}let u=t,d;Ai(e,!1),t?(t.el=c.el,oe(e,t,o)):t=c,n&&re(n),(d=t.props&&t.props.onVnodeBeforeUpdate)&&sa(d,s,t,c),Ai(e,!0);let f=ti(e),p=e.subTree;e.subTree=f,v(p,f,m(p.el),he(p),e,i,a),t.el=f.el,u===null&&si(e,f.el),r&&Ei(r,i),(d=t.props&&t.props.onVnodeUpdated)&&Ei(()=>sa(d,s,t,c),i)}else{let o,{el:s,props:c}=t,{bm:l,m:u,parent:d,root:f,type:p}=e,m=or(t);if(Ai(e,!1),l&&re(l),!m&&(o=c&&c.onVnodeBeforeMount)&&sa(o,d,t),Ai(e,!0),s&&R){let t=()=>{e.subTree=ti(e),R(s,e.subTree,e,i,null)};m&&p.__asyncHydrate?p.__asyncHydrate(s,e,t):t()}else{f.ce&&f.ce._hasShadowRoot()&&f.ce._injectChildStyle(p);let o=e.subTree=ti(e);v(null,o,n,r,e,i,a),t.el=o.el}if(u&&Ei(u,i),!m&&(o=c&&c.onVnodeMounted)){let e=t;Ei(()=>sa(o,d,e),i)}(t.shapeFlag&256||d&&or(d.vnode)&&d.vnode.shapeFlag&256)&&e.a&&Ei(e.a,i),e.isMounted=!0,t=n=r=null}};e.scope.on();let c=e.effect=new Se(s);e.scope.off();let l=e.update=c.run.bind(c),u=e.job=c.runIfDirty.bind(c);u.i=e,u.id=e.uid,c.scheduler=()=>hn(u),Ai(e,!0),l()},oe=(e,t,n)=>{t.component=e;let r=e.vnode.props;e.vnode=t,e.next=null,fi(e,t.props,r,n),Ti(e,t.children,n),Ie(),vn(e),Le()},M=(e,t,n,r,i,a,o,s,c=!1)=>{let l=e&&e.children,u=e?e.shapeFlag:0,d=t.children,{patchFlag:f,shapeFlag:m}=t;if(f>0){if(f&128){le(l,d,n,r,i,a,o,s,c);return}else if(f&256){ce(l,d,n,r,i,a,o,s,c);return}}m&8?(u&16&&me(l,i,a),d!==l&&p(n,d)):u&16?m&16?le(l,d,n,r,i,a,o,s,c):me(l,i,a,!0):(u&8&&p(n,``),m&16&&D(d,n,r,i,a,o,s,c))},ce=(e,t,r,i,a,o,s,c,l)=>{e||=n,t||=n;let u=e.length,d=t.length,f=Math.min(u,d),p;for(p=0;p<f;p++){let n=t[p]=l?ia(t[p]):ra(t[p]);v(e[p],n,r,null,a,o,s,c,l)}u>d?me(e,a,o,!0,!1,f):D(t,r,i,a,o,s,c,l,f)},le=(e,t,r,i,a,o,s,c,l)=>{let u=0,d=t.length,f=e.length-1,p=d-1;for(;u<=f&&u<=p;){let n=e[u],i=t[u]=l?ia(t[u]):ra(t[u]);if(Xi(n,i))v(n,i,r,null,a,o,s,c,l);else break;u++}for(;u<=f&&u<=p;){let n=e[f],i=t[p]=l?ia(t[p]):ra(t[p]);if(Xi(n,i))v(n,i,r,null,a,o,s,c,l);else break;f--,p--}if(u>f){if(u<=p){let e=p+1,n=e<d?t[e].el:i;for(;u<=p;)v(null,t[u]=l?ia(t[u]):ra(t[u]),r,n,a,o,s,c,l),u++}}else if(u>p)for(;u<=f;)de(e[u],a,o,!0),u++;else{let m=u,h=u,g=new Map;for(u=h;u<=p;u++){let e=t[u]=l?ia(t[u]):ra(t[u]);e.key!=null&&g.set(e.key,u)}let _,y=0,b=p-h+1,x=!1,S=0,C=Array(b);for(u=0;u<b;u++)C[u]=0;for(u=m;u<=f;u++){let n=e[u];if(y>=b){de(n,a,o,!0);continue}let i;if(n.key!=null)i=g.get(n.key);else for(_=h;_<=p;_++)if(C[_-h]===0&&Xi(n,t[_])){i=_;break}i===void 0?de(n,a,o,!0):(C[i-h]=u+1,i>=S?S=i:x=!0,v(n,t[i],r,null,a,o,s,c,l),y++)}let w=x?Ni(C):n;for(_=w.length-1,u=b-1;u>=0;u--){let e=h+u,n=t[e],f=t[e+1],p=e+1<d?f.el||Ii(f):i;C[u]===0?v(null,n,r,p,a,o,s,c,l):x&&(_<0||u!==w[_]?ue(n,r,p,2):_--)}}},ue=(e,t,n,r,i=null)=>{let{el:a,type:c,transition:l,children:u,shapeFlag:d}=e;if(d&6){ue(e.component.subTree,t,n,r);return}if(d&128){e.suspense.move(t,n,r);return}if(d&64){c.move(e,t,n,I);return}if(c===q){o(a,t,n);for(let e=0;e<u.length;e++)ue(u[e],t,n,r);o(e.anchor,t,n);return}if(c===Vi){S(e,t,n);return}if(r!==2&&d&1&&l)if(r===0)l.beforeEnter(a),o(a,t,n),Ei(()=>l.enter(a),i);else{let{leave:r,delayLeave:i,afterLeave:c}=l,u=()=>{e.ctx.isUnmounted?s(a):o(a,t,n)},d=()=>{a._isLeaving&&a[zn](!0),r(a,()=>{u(),c&&c()})};i?i(a,u,d):d()}else o(a,t,n)},de=(e,t,n,r=!1,i=!1)=>{let{type:a,props:o,ref:s,children:c,dynamicChildren:l,shapeFlag:u,patchFlag:d,dirs:f,cacheIndex:p}=e;if(d===-2&&(i=!1),s!=null&&(Ie(),ir(s,null,n,e,!0),Le()),p!=null&&(t.renderCache[p]=void 0),u&256){t.ctx.deactivate(e);return}let m=u&1&&f,h=!or(e),g;if(h&&(g=o&&o.onVnodeBeforeUnmount)&&sa(g,t,e),u&6)pe(e.component,n,r);else{if(u&128){e.suspense.unmount(n,r);return}m&&Dn(e,null,t,`beforeUnmount`),u&64?e.type.remove(e,t,n,I,r):l&&!l.hasOnce&&(a!==q||d>0&&d&64)?me(l,t,n,!1,!0):(a===q&&d&384||!i&&u&16)&&me(c,t,n),r&&N(e)}(h&&(g=o&&o.onVnodeUnmounted)||m)&&Ei(()=>{g&&sa(g,t,e),m&&Dn(e,null,t,`unmounted`)},n)},N=e=>{let{type:t,el:n,anchor:r,transition:i}=e;if(t===q){fe(n,r);return}if(t===Vi){C(e);return}let a=()=>{s(n),i&&!i.persisted&&i.afterLeave&&i.afterLeave()};if(e.shapeFlag&1&&i&&!i.persisted){let{leave:t,delayLeave:r}=i,o=()=>t(n,a);r?r(e.el,a,o):o()}else a()},fe=(e,t)=>{let n;for(;e!==t;)n=h(e),s(e),e=n;s(t)},pe=(e,t,n)=>{let{bum:r,scope:i,job:a,subTree:o,um:s,m:c,a:l}=e;Fi(c),Fi(l),r&&re(r),i.stop(),a&&(a.flags|=8,de(o,e,t,n)),s&&Ei(s,t),Ei(()=>{e.isUnmounted=!0},t)},me=(e,t,n,r=!1,i=!1,a=0)=>{for(let o=a;o<e.length;o++)de(e[o],t,n,r,i)},he=e=>{if(e.shapeFlag&6)return he(e.component.subTree);if(e.shapeFlag&128)return e.suspense.next();let t=h(e.anchor||e.el),n=t&&t[Ln];return n?h(n):t},P=!1,F=(e,t,n)=>{let r;e==null?t._vnode&&(de(t._vnode,null,null,!0),r=t._vnode.component):v(t._vnode||null,e,t,null,null,null,n),t._vnode=e,P||=(P=!0,vn(r),yn(),!1)},I={p:v,um:de,m:ue,r:N,mt:j,mc:D,pc:M,pbc:k,n:he,o:e},L,R;return i&&([L,R]=i(I)),{render:F,hydrate:L,createApp:Jr(F,L)}}function ki({type:e,props:t},n){return n===`svg`&&e===`foreignObject`||n===`mathml`&&e===`annotation-xml`&&t&&t.encoding&&t.encoding.includes(`html`)?void 0:n}function Ai({effect:e,job:t},n){n?(e.flags|=32,t.flags|=4):(e.flags&=-33,t.flags&=-5)}function ji(e,t){return(!e||e&&!e.pendingBranch)&&t&&!t.persisted}function Mi(e,t,n=!1){let r=e.children,i=t.children;if(d(r)&&d(i))for(let e=0;e<r.length;e++){let t=r[e],a=i[e];a.shapeFlag&1&&!a.dynamicChildren&&((a.patchFlag<=0||a.patchFlag===32)&&(a=i[e]=ia(i[e]),a.el=t.el),!n&&a.patchFlag!==-2&&Mi(t,a)),a.type===zi&&(a.patchFlag===-1&&(a=i[e]=ia(a)),a.el=t.el),a.type===Bi&&!a.el&&(a.el=t.el)}}function Ni(e){let t=e.slice(),n=[0],r,i,a,o,s,c=e.length;for(r=0;r<c;r++){let c=e[r];if(c!==0){if(i=n[n.length-1],e[i]<c){t[r]=i,n.push(r);continue}for(a=0,o=n.length-1;a<o;)s=a+o>>1,e[n[s]]<c?a=s+1:o=s;c<e[n[a]]&&(a>0&&(t[r]=n[a-1]),n[a]=r)}}for(a=n.length,o=n[a-1];a-- >0;)n[a]=o,o=t[o];return n}function Pi(e){let t=e.subTree.component;if(t)return t.asyncDep&&!t.asyncResolved?t:Pi(t)}function Fi(e){if(e)for(let t=0;t<e.length;t++)e[t].flags|=8}function Ii(e){if(e.placeholder)return e.placeholder;let t=e.component;return t?Ii(t.subTree):null}var Li=e=>e.__isSuspense;function Ri(e,t){t&&t.pendingBranch?d(e)?t.effects.push(...e):t.effects.push(e):_n(e)}var q=Symbol.for(`v-fgt`),zi=Symbol.for(`v-txt`),Bi=Symbol.for(`v-cmt`),Vi=Symbol.for(`v-stc`),Hi=[],Ui=null;function J(e=!1){Hi.push(Ui=e?null:[])}function Wi(){Hi.pop(),Ui=Hi[Hi.length-1]||null}var Gi=1;function Ki(e,t=!1){Gi+=e,e<0&&Ui&&t&&(Ui.hasOnce=!0)}function qi(e){return e.dynamicChildren=Gi>0?Ui||n:null,Wi(),Gi>0&&Ui&&Ui.push(e),e}function Y(e,t,n,r,i,a){return qi(X(e,t,n,r,i,a,!0))}function Ji(e,t,n,r,i){return qi(Z(e,t,n,r,i,!0))}function Yi(e){return e?e.__v_isVNode===!0:!1}function Xi(e,t){return e.type===t.type&&e.key===t.key}var Zi=({key:e})=>e??null,Qi=({ref:e,ref_key:t,ref_for:n})=>(typeof e==`number`&&(e=``+e),e==null?null:g(e)||W(e)||h(e)?{i:Sn,r:e,k:t,f:!!n}:e);function X(e,t=null,n=null,r=0,i=null,a=e===q?0:1,o=!1,s=!1){let c={__v_isVNode:!0,__v_skip:!0,type:e,props:t,key:t&&Zi(t),ref:t&&Qi(t),scopeId:Cn,slotScopeIds:null,children:n,component:null,suspense:null,ssContent:null,ssFallback:null,dirs:null,transition:null,el:null,anchor:null,target:null,targetStart:null,targetAnchor:null,staticCount:0,shapeFlag:a,patchFlag:r,dynamicProps:i,dynamicChildren:null,appContext:null,ctx:Sn};return s?(aa(c,n),a&128&&e.normalize(c)):n&&(c.shapeFlag|=g(n)?8:16),Gi>0&&!o&&Ui&&(c.patchFlag>0||a&6)&&c.patchFlag!==32&&Ui.push(c),c}var Z=$i;function $i(e,t=null,n=null,r=0,i=null,a=!1){if((!e||e===wr)&&(e=Bi),Yi(e)){let r=ta(e,t,!0);return n&&aa(r,n),Gi>0&&!a&&Ui&&(r.shapeFlag&6?Ui[Ui.indexOf(e)]=r:Ui.push(r)),r.patchFlag=-2,r}if(Oa(e)&&(e=e.__vccOpts),t){t=ea(t);let{class:e,style:n}=t;e&&!g(e)&&(t.class=N(e)),v(n)&&(It(n)&&!d(n)&&(n=s({},n)),t.style=M(n))}let o=g(e)?1:Li(e)?128:Rn(e)?64:v(e)?4:h(e)?2:0;return X(e,t,n,r,i,o,a,!0)}function ea(e){return e?It(e)||ui(e)?s({},e):e:null}function ta(e,t,n=!1,r=!1){let{props:i,ref:a,patchFlag:o,children:s,transition:c}=e,l=t?oa(i||{},t):i,u={__v_isVNode:!0,__v_skip:!0,type:e.type,props:l,key:l&&Zi(l),ref:t&&t.ref?n&&a?d(a)?a.concat(Qi(t)):[a,Qi(t)]:Qi(t):a,scopeId:e.scopeId,slotScopeIds:e.slotScopeIds,children:s,target:e.target,targetStart:e.targetStart,targetAnchor:e.targetAnchor,staticCount:e.staticCount,shapeFlag:e.shapeFlag,patchFlag:t&&e.type!==q?o===-1?16:o|16:o,dynamicProps:e.dynamicProps,dynamicChildren:e.dynamicChildren,appContext:e.appContext,dirs:e.dirs,transition:c,component:e.component,suspense:e.suspense,ssContent:e.ssContent&&ta(e.ssContent),ssFallback:e.ssFallback&&ta(e.ssFallback),placeholder:e.placeholder,el:e.el,anchor:e.anchor,ctx:e.ctx,ce:e.ce};return c&&r&&Qn(u,c.clone(u)),u}function na(e=` `,t=0){return Z(zi,null,e,t)}function Q(e=``,t=!1){return t?(J(),Ji(Bi,null,e)):Z(Bi,null,e)}function ra(e){return e==null||typeof e==`boolean`?Z(Bi):d(e)?Z(q,null,e.slice()):Yi(e)?ia(e):Z(zi,null,String(e))}function ia(e){return e.el===null&&e.patchFlag!==-1||e.memo?e:ta(e)}function aa(e,t){let n=0,{shapeFlag:r}=e;if(t==null)t=null;else if(d(t))n=16;else if(typeof t==`object`)if(r&65){let n=t.default;n&&(n._c&&(n._d=!1),aa(e,n()),n._c&&(n._d=!0));return}else{n=32;let r=t._;!r&&!ui(t)?t._ctx=Sn:r===3&&Sn&&(Sn.slots._===1?t._=1:(t._=2,e.patchFlag|=1024))}else h(t)?(t={default:t,_ctx:Sn},n=32):(t=String(t),r&64?(n=16,t=[na(t)]):n=8);e.children=t,e.shapeFlag|=n}function oa(...e){let t={};for(let n=0;n<e.length;n++){let r=e[n];for(let e in r)if(e===`class`)t.class!==r.class&&(t.class=N([t.class,r.class]));else if(e===`style`)t.style=M([t.style,r.style]);else if(a(e)){let n=t[e],i=r[e];i&&n!==i&&!(d(n)&&n.includes(i))&&(t[e]=n?[].concat(n,i):i)}else e!==``&&(t[e]=r[e])}return t}function sa(e,t,n,r=null){nn(e,t,7,[n,r])}var ca=Kr(),la=0;function ua(e,n,r){let i=e.type,a=(n?n.appContext:e.appContext)||ca,o={uid:la++,vnode:e,type:i,parent:n,appContext:a,root:null,next:null,subTree:null,effect:null,update:null,job:null,scope:new _e(!0),render:null,proxy:null,exposed:null,exposeProxy:null,withProxy:null,provides:n?n.provides:Object.create(a.provides),ids:n?n.ids:[``,0,0],accessCache:null,renderCache:[],components:null,directives:null,propsOptions:gi(i,a),emitsOptions:$r(i,a),emit:null,emitted:null,propsDefaults:t,inheritAttrs:i.inheritAttrs,ctx:t,data:t,props:t,attrs:t,slots:t,refs:t,setupState:t,setupContext:null,suspense:r,suspenseId:r?r.pendingId:0,asyncDep:null,asyncResolved:!1,isMounted:!1,isUnmounted:!1,isDeactivated:!1,bc:null,c:null,bm:null,m:null,bu:null,u:null,um:null,bum:null,da:null,a:null,rtg:null,rtc:null,ec:null,sp:null};return o.ctx={_:o},o.root=n?n.root:o,o.emit=Zr.bind(null,o),e.ce&&e.ce(o),o}var da=null,fa=()=>da||Sn,pa,ma;{let e=se(),t=(t,n)=>{let r;return(r=e[t])||(r=e[t]=[]),r.push(n),e=>{r.length>1?r.forEach(t=>t(e)):r[0](e)}};pa=t(`__VUE_INSTANCE_SETTERS__`,e=>da=e),ma=t(`__VUE_SSR_SETTERS__`,e=>va=e)}var ha=e=>{let t=da;return pa(e),e.scope.on(),()=>{e.scope.off(),pa(t)}},ga=()=>{da&&da.scope.off(),pa(null)};function _a(e){return e.vnode.shapeFlag&4}var va=!1;function ya(e,t=!1,n=!1){t&&ma(t);let{props:r,children:i}=e.vnode,a=_a(e);di(e,r,a,t),wi(e,i,n||t);let o=a?ba(e,t):void 0;return t&&ma(!1),o}function ba(e,t){let n=e.type;e.accessCache=Object.create(null),e.proxy=new Proxy(e.ctx,kr);let{setup:r}=n;if(r){Ie();let n=e.setupContext=r.length>1?Ea(e):null,i=ha(e),a=tn(r,e,0,[e.props,n]),o=y(a);if(Le(),i(),(o||e.sp)&&!or(e)&&tr(e),o){if(a.then(ga,ga),t)return a.then(n=>{xa(e,n,t)}).catch(t=>{rn(t,e,0)});e.asyncDep=a}else xa(e,a,t)}else wa(e,t)}function xa(e,t,n){h(t)?e.type.__ssrInlineRender?e.ssrRender=t:e.render=t:v(t)&&(e.setupState=Ut(t)),wa(e,n)}var Sa,Ca;function wa(e,t,n){let i=e.type;if(!e.render){if(!t&&Sa&&!i.render){let t=i.template||Ir(e).template;if(t){let{isCustomElement:n,compilerOptions:r}=e.appContext.config,{delimiters:a,compilerOptions:o}=i;i.render=Sa(t,s(s({isCustomElement:n,delimiters:a},r),o))}}e.render=i.render||r,Ca&&Ca(e)}{let t=ha(e);Ie();try{Mr(e)}finally{Le(),t()}}}var Ta={get(e,t){return H(e,`get`,``),e[t]}};function Ea(e){return{attrs:new Proxy(e.attrs,Ta),slots:e.slots,emit:e.emit,expose:t=>{e.exposed=t||{}}}}function Da(e){return e.exposed?e.exposeProxy||=new Proxy(Ut(Lt(e.exposed)),{get(t,n){if(n in t)return t[n];if(n in Dr)return Dr[n](e)},has(e,t){return t in e||t in Dr}}):e.proxy}function Oa(e){return h(e)&&`__vccOpts`in e}var $=(e,t)=>Jt(e,t,va);function ka(e,t,n){try{Ki(-1);let r=arguments.length;return r===2?v(t)&&!d(t)?Yi(t)?Z(e,null,[t]):Z(e,t):Z(e,null,t):(r>3?n=Array.prototype.slice.call(arguments,2):r===3&&Yi(n)&&(n=[n]),Z(e,t,n))}finally{Ki(1)}}var Aa=`3.5.28`,ja=void 0,Ma=typeof window<`u`&&window.trustedTypes;if(Ma)try{ja=Ma.createPolicy(`vue`,{createHTML:e=>e})}catch{}var Na=ja?e=>ja.createHTML(e):e=>e,Pa=`http://www.w3.org/2000/svg`,Fa=`http://www.w3.org/1998/Math/MathML`,Ia=typeof document<`u`?document:null,La=Ia&&Ia.createElement(`template`),Ra={insert:(e,t,n)=>{t.insertBefore(e,n||null)},remove:e=>{let t=e.parentNode;t&&t.removeChild(e)},createElement:(e,t,n,r)=>{let i=t===`svg`?Ia.createElementNS(Pa,e):t===`mathml`?Ia.createElementNS(Fa,e):n?Ia.createElement(e,{is:n}):Ia.createElement(e);return e===`select`&&r&&r.multiple!=null&&i.setAttribute(`multiple`,r.multiple),i},createText:e=>Ia.createTextNode(e),createComment:e=>Ia.createComment(e),setText:(e,t)=>{e.nodeValue=t},setElementText:(e,t)=>{e.textContent=t},parentNode:e=>e.parentNode,nextSibling:e=>e.nextSibling,querySelector:e=>Ia.querySelector(e),setScopeId(e,t){e.setAttribute(t,``)},insertStaticContent(e,t,n,r,i,a){let o=n?n.previousSibling:t.lastChild;if(i&&(i===a||i.nextSibling))for(;t.insertBefore(i.cloneNode(!0),n),!(i===a||!(i=i.nextSibling)););else{La.innerHTML=Na(r===`svg`?`<svg>${e}</svg>`:r===`mathml`?`<math>${e}</math>`:e);let i=La.content;if(r===`svg`||r===`mathml`){let e=i.firstChild;for(;e.firstChild;)i.appendChild(e.firstChild);i.removeChild(e)}t.insertBefore(i,n)}return[o?o.nextSibling:t.firstChild,n?n.previousSibling:t.lastChild]}},za=`transition`,Ba=`animation`,Va=Symbol(`_vtc`),Ha={name:String,type:String,css:{type:Boolean,default:!0},duration:[String,Number,Object],enterFromClass:String,enterActiveClass:String,enterToClass:String,appearFromClass:String,appearActiveClass:String,appearToClass:String,leaveFromClass:String,leaveActiveClass:String,leaveToClass:String},Ua=s({},Un,Ha),Wa=(e=>(e.displayName=`Transition`,e.props=Ua,e))((e,{slots:t})=>ka(qn,qa(e),t)),Ga=(e,t=[])=>{d(e)?e.forEach(e=>e(...t)):e&&e(...t)},Ka=e=>e?d(e)?e.some(e=>e.length>1):e.length>1:!1;function qa(e){let t={};for(let n in e)n in Ha||(t[n]=e[n]);if(e.css===!1)return t;let{name:n=`v`,type:r,duration:i,enterFromClass:a=`${n}-enter-from`,enterActiveClass:o=`${n}-enter-active`,enterToClass:c=`${n}-enter-to`,appearFromClass:l=a,appearActiveClass:u=o,appearToClass:d=c,leaveFromClass:f=`${n}-leave-from`,leaveActiveClass:p=`${n}-leave-active`,leaveToClass:m=`${n}-leave-to`}=e,h=Ja(i),g=h&&h[0],_=h&&h[1],{onBeforeEnter:v,onEnter:y,onEnterCancelled:b,onLeave:x,onLeaveCancelled:S,onBeforeAppear:C=v,onAppear:w=y,onAppearCancelled:T=b}=t,ee=(e,t,n,r)=>{e._enterCancelled=r,Za(e,t?d:c),Za(e,t?u:o),n&&n()},E=(e,t)=>{e._isLeaving=!1,Za(e,f),Za(e,m),Za(e,p),t&&t()},D=e=>(t,n)=>{let i=e?w:y,o=()=>ee(t,e,n);Ga(i,[t,o]),Qa(()=>{Za(t,e?l:a),Xa(t,e?d:c),Ka(i)||eo(t,r,g,o)})};return s(t,{onBeforeEnter(e){Ga(v,[e]),Xa(e,a),Xa(e,o)},onBeforeAppear(e){Ga(C,[e]),Xa(e,l),Xa(e,u)},onEnter:D(!1),onAppear:D(!0),onLeave(e,t){e._isLeaving=!0;let n=()=>E(e,t);Xa(e,f),e._enterCancelled?(Xa(e,p),io(e)):(io(e),Xa(e,p)),Qa(()=>{e._isLeaving&&(Za(e,f),Xa(e,m),Ka(x)||eo(e,r,_,n))}),Ga(x,[e,n])},onEnterCancelled(e){ee(e,!1,void 0,!0),Ga(b,[e])},onAppearCancelled(e){ee(e,!0,void 0,!0),Ga(T,[e])},onLeaveCancelled(e){E(e),Ga(S,[e])}})}function Ja(e){if(e==null)return null;if(v(e))return[Ya(e.enter),Ya(e.leave)];{let t=Ya(e);return[t,t]}}function Ya(e){return ae(e)}function Xa(e,t){t.split(/\\s+/).forEach(t=>t&&e.classList.add(t)),(e[Va]||(e[Va]=new Set)).add(t)}function Za(e,t){t.split(/\\s+/).forEach(t=>t&&e.classList.remove(t));let n=e[Va];n&&(n.delete(t),n.size||(e[Va]=void 0))}function Qa(e){requestAnimationFrame(()=>{requestAnimationFrame(e)})}var $a=0;function eo(e,t,n,r){let i=e._endId=++$a,a=()=>{i===e._endId&&r()};if(n!=null)return setTimeout(a,n);let{type:o,timeout:s,propCount:c}=to(e,t);if(!o)return r();let l=o+`end`,u=0,d=()=>{e.removeEventListener(l,f),a()},f=t=>{t.target===e&&++u>=c&&d()};setTimeout(()=>{u<c&&d()},s+1),e.addEventListener(l,f)}function to(e,t){let n=window.getComputedStyle(e),r=e=>(n[e]||``).split(`, `),i=r(`${za}Delay`),a=r(`${za}Duration`),o=no(i,a),s=r(`${Ba}Delay`),c=r(`${Ba}Duration`),l=no(s,c),u=null,d=0,f=0;t===za?o>0&&(u=za,d=o,f=a.length):t===Ba?l>0&&(u=Ba,d=l,f=c.length):(d=Math.max(o,l),u=d>0?o>l?za:Ba:null,f=u?u===za?a.length:c.length:0);let p=u===za&&/\\b(?:transform|all)(?:,|$)/.test(r(`${za}Property`).toString());return{type:u,timeout:d,propCount:f,hasTransform:p}}function no(e,t){for(;e.length<t.length;)e=e.concat(e);return Math.max(...t.map((t,n)=>ro(t)+ro(e[n])))}function ro(e){return e===`auto`?0:Number(e.slice(0,-1).replace(`,`,`.`))*1e3}function io(e){return(e?e.ownerDocument:document).body.offsetHeight}function ao(e,t,n){let r=e[Va];r&&(t=(t?[t,...r]:[...r]).join(` `)),t==null?e.removeAttribute(`class`):n?e.setAttribute(`class`,t):e.className=t}var oo=Symbol(`_vod`),so=Symbol(`_vsh`),co=Symbol(``),lo=/(?:^|;)\\s*display\\s*:/;function uo(e,t,n){let r=e.style,i=g(n),a=!1;if(n&&!i){if(t)if(g(t))for(let e of t.split(`;`)){let t=e.slice(0,e.indexOf(`:`)).trim();n[t]??po(r,t,``)}else for(let e in t)n[e]??po(r,e,``);for(let e in n)e===`display`&&(a=!0),po(r,e,n[e])}else if(i){if(t!==n){let e=r[co];e&&(n+=`;`+e),r.cssText=n,a=lo.test(n)}}else t&&e.removeAttribute(`style`);oo in e&&(e[oo]=a?r.display:``,e[so]&&(r.display=`none`))}var fo=/\\s*!important$/;function po(e,t,n){if(d(n))n.forEach(n=>po(e,t,n));else if(n??=``,t.startsWith(`--`))e.setProperty(t,n);else{let r=go(e,t);fo.test(n)?e.setProperty(k(r),n.replace(fo,``),`important`):e[r]=n}}var mo=[`Webkit`,`Moz`,`ms`],ho={};function go(e,t){let n=ho[t];if(n)return n;let r=D(t);if(r!==`filter`&&r in e)return ho[t]=r;r=te(r);for(let n=0;n<mo.length;n++){let i=mo[n]+r;if(i in e)return ho[t]=i}return t}var _o=`http://www.w3.org/1999/xlink`;function vo(e,t,n,r,i,a=pe(t)){r&&t.startsWith(`xlink:`)?n==null?e.removeAttributeNS(_o,t.slice(6,t.length)):e.setAttributeNS(_o,t,n):n==null||a&&!me(n)?e.removeAttribute(t):e.setAttribute(t,a?``:_(n)?String(n):n)}function yo(e,t,n,r,i){if(t===`innerHTML`||t===`textContent`){n!=null&&(e[t]=t===`innerHTML`?Na(n):n);return}let a=e.tagName;if(t===`value`&&a!==`PROGRESS`&&!a.includes(`-`)){let r=a===`OPTION`?e.getAttribute(`value`)||``:e.value,i=n==null?e.type===`checkbox`?`on`:``:String(n);(r!==i||!(`_value`in e))&&(e.value=i),n??e.removeAttribute(t),e._value=n;return}let o=!1;if(n===``||n==null){let r=typeof e[t];r===`boolean`?n=me(n):n==null&&r===`string`?(n=``,o=!0):r===`number`&&(n=0,o=!0)}try{e[t]=n}catch{}o&&e.removeAttribute(i||t)}function bo(e,t,n,r){e.addEventListener(t,n,r)}function xo(e,t,n,r){e.removeEventListener(t,n,r)}var So=Symbol(`_vei`);function Co(e,t,n,r,i=null){let a=e[So]||(e[So]={}),o=a[t];if(r&&o)o.value=r;else{let[n,s]=To(t);r?bo(e,n,a[t]=ko(r,i),s):o&&(xo(e,n,o,s),a[t]=void 0)}}var wo=/(?:Once|Passive|Capture)$/;function To(e){let t;if(wo.test(e)){t={};let n;for(;n=e.match(wo);)e=e.slice(0,e.length-n[0].length),t[n[0].toLowerCase()]=!0}return[e[2]===`:`?e.slice(3):k(e.slice(2)),t]}var Eo=0,Do=Promise.resolve(),Oo=()=>Eo||=(Do.then(()=>Eo=0),Date.now());function ko(e,t){let n=e=>{if(!e._vts)e._vts=Date.now();else if(e._vts<=n.attached)return;nn(Ao(e,n.value),t,5,[e])};return n.value=e,n.attached=Oo(),n}function Ao(e,t){if(d(t)){let n=e.stopImmediatePropagation;return e.stopImmediatePropagation=()=>{n.call(e),e._stopped=!0},t.map(e=>t=>!t._stopped&&e&&e(t))}else return t}var jo=e=>e.charCodeAt(0)===111&&e.charCodeAt(1)===110&&e.charCodeAt(2)>96&&e.charCodeAt(2)<123,Mo=(e,t,n,r,i,s)=>{let c=i===`svg`;t===`class`?ao(e,r,c):t===`style`?uo(e,n,r):a(t)?o(t)||Co(e,t,n,r,s):(t[0]===`.`?(t=t.slice(1),!0):t[0]===`^`?(t=t.slice(1),!1):No(e,t,r,c))?(yo(e,t,r),!e.tagName.includes(`-`)&&(t===`value`||t===`checked`||t===`selected`)&&vo(e,t,r,c,s,t!==`value`)):e._isVueCE&&(/[A-Z]/.test(t)||!g(r))?yo(e,D(t),r,s,t):(t===`true-value`?e._trueValue=r:t===`false-value`&&(e._falseValue=r),vo(e,t,r,c))};function No(e,t,n,r){if(r)return!!(t===`innerHTML`||t===`textContent`||t in e&&jo(t)&&h(n));if(t===`spellcheck`||t===`draggable`||t===`translate`||t===`autocorrect`||t===`sandbox`&&e.tagName===`IFRAME`||t===`form`||t===`list`&&e.tagName===`INPUT`||t===`type`&&e.tagName===`TEXTAREA`)return!1;if(t===`width`||t===`height`){let t=e.tagName;if(t===`IMG`||t===`VIDEO`||t===`CANVAS`||t===`SOURCE`)return!1}return jo(t)&&g(n)?!1:t in e}var Po=e=>{let t=e.props[`onUpdate:modelValue`]||!1;return d(t)?e=>re(t,e):t};function Fo(e){e.target.composing=!0}function Io(e){let t=e.target;t.composing&&(t.composing=!1,t.dispatchEvent(new Event(`input`)))}var Lo=Symbol(`_assign`);function Ro(e,t,n){return t&&(e=e.trim()),n&&(e=ie(e)),e}var zo={created(e,{modifiers:{lazy:t,trim:n,number:r}},i){e[Lo]=Po(i);let a=r||i.props&&i.props.type===`number`;bo(e,t?`change`:`input`,t=>{t.target.composing||e[Lo](Ro(e.value,n,a))}),(n||a)&&bo(e,`change`,()=>{e.value=Ro(e.value,n,a)}),t||(bo(e,`compositionstart`,Fo),bo(e,`compositionend`,Io),bo(e,`change`,Io))},mounted(e,{value:t}){e.value=t??``},beforeUpdate(e,{value:t,oldValue:n,modifiers:{lazy:r,trim:i,number:a}},o){if(e[Lo]=Po(o),e.composing)return;let s=(a||e.type===`number`)&&!/^0\\d/.test(e.value)?ie(e.value):e.value,c=t??``;s!==c&&(document.activeElement===e&&e.type!==`range`&&(r&&t===n||i&&e.value.trim()===c)||(e.value=c))}},Bo={deep:!0,created(e,t,n){e[Lo]=Po(n),bo(e,`change`,()=>{let t=e._modelValue,n=Ho(e),r=e.checked,i=e[Lo];if(d(t)){let e=F(t,n),a=e!==-1;if(r&&!a)i(t.concat(n));else if(!r&&a){let n=[...t];n.splice(e,1),i(n)}}else if(p(t)){let e=new Set(t);r?e.add(n):e.delete(n),i(e)}else i(Uo(e,r))})},mounted:Vo,beforeUpdate(e,t,n){e[Lo]=Po(n),Vo(e,t,n)}};function Vo(e,{value:t,oldValue:n},r){e._modelValue=t;let i;if(d(t))i=F(t,r.props.value)>-1;else if(p(t))i=t.has(r.props.value);else{if(t===n)return;i=P(t,Uo(e,!0))}e.checked!==i&&(e.checked=i)}function Ho(e){return`_value`in e?e._value:e.value}function Uo(e,t){let n=t?`_trueValue`:`_falseValue`;return n in e?e[n]:t}var Wo=[`ctrl`,`shift`,`alt`,`meta`],Go={stop:e=>e.stopPropagation(),prevent:e=>e.preventDefault(),self:e=>e.target!==e.currentTarget,ctrl:e=>!e.ctrlKey,shift:e=>!e.shiftKey,alt:e=>!e.altKey,meta:e=>!e.metaKey,left:e=>`button`in e&&e.button!==0,middle:e=>`button`in e&&e.button!==1,right:e=>`button`in e&&e.button!==2,exact:(e,t)=>Wo.some(n=>e[`${n}Key`]&&!t.includes(n))},Ko=(e,t)=>{if(!e)return e;let n=e._withMods||={},r=t.join(`.`);return n[r]||(n[r]=((n,...r)=>{for(let e=0;e<t.length;e++){let r=Go[t[e]];if(r&&r(n,t))return}return e(n,...r)}))},qo={esc:`escape`,space:` `,up:`arrow-up`,left:`arrow-left`,right:`arrow-right`,down:`arrow-down`,delete:`backspace`},Jo=(e,t)=>{let n=e._withKeys||={},r=t.join(`.`);return n[r]||(n[r]=(n=>{if(!(`key`in n))return;let r=k(n.key);if(t.some(e=>e===r||qo[e]===r))return e(n)}))},Yo=s({patchProp:Mo},Ra),Xo;function Zo(){return Xo||=Di(Yo)}var Qo=((...e)=>{let t=Zo().createApp(...e),{mount:n}=t;return t.mount=e=>{let r=es(e);if(!r)return;let i=t._component;!h(i)&&!i.render&&!i.template&&(i.template=r.innerHTML),r.nodeType===1&&(r.textContent=``);let a=n(r,!1,$o(r));return r instanceof Element&&(r.removeAttribute(`v-cloak`),r.setAttribute(`data-v-app`,``)),a},t});function $o(e){if(e instanceof SVGElement)return`svg`;if(typeof MathMLElement==`function`&&e instanceof MathMLElement)return`mathml`}function es(e){return g(e)?document.querySelector(e):e}var ts=typeof window<`u`,ns,rs=e=>ns=e,is=Symbol();function as(e){return e&&typeof e==`object`&&Object.prototype.toString.call(e)===`[object Object]`&&typeof e.toJSON!=`function`}var os;(function(e){e.direct=`direct`,e.patchObject=`patch object`,e.patchFunction=`patch function`})(os||={});var ss=typeof window==`object`&&window.window===window?window:typeof self==`object`&&self.self===self?self:typeof global==`object`&&global.global===global?global:typeof globalThis==`object`?globalThis:{HTMLElement:null};function cs(e,{autoBom:t=!1}={}){return t&&/^\\s*(?:text\\/\\S*|application\\/xml|\\S*\\/\\S*\\+xml)\\s*;.*charset\\s*=\\s*utf-8/i.test(e.type)?new Blob([`﻿`,e],{type:e.type}):e}function ls(e,t,n){let r=new XMLHttpRequest;r.open(`GET`,e),r.responseType=`blob`,r.onload=function(){ms(r.response,t,n)},r.onerror=function(){console.error(`could not download file`)},r.send()}function us(e){let t=new XMLHttpRequest;t.open(`HEAD`,e,!1);try{t.send()}catch{}return t.status>=200&&t.status<=299}function ds(e){try{e.dispatchEvent(new MouseEvent(`click`))}catch{let t=new MouseEvent(`click`,{bubbles:!0,cancelable:!0,view:window,detail:0,screenX:80,screenY:20,clientX:80,clientY:20,ctrlKey:!1,altKey:!1,shiftKey:!1,metaKey:!1,button:0,relatedTarget:null});e.dispatchEvent(t)}}var fs=typeof navigator==`object`?navigator:{userAgent:``},ps=/Macintosh/.test(fs.userAgent)&&/AppleWebKit/.test(fs.userAgent)&&!/Safari/.test(fs.userAgent),ms=ts?typeof HTMLAnchorElement<`u`&&`download`in HTMLAnchorElement.prototype&&!ps?hs:`msSaveOrOpenBlob`in fs?gs:_s:()=>{};function hs(e,t=`download`,n){let r=document.createElement(`a`);r.download=t,r.rel=`noopener`,typeof e==`string`?(r.href=e,r.origin===location.origin?ds(r):us(r.href)?ls(e,t,n):(r.target=`_blank`,ds(r))):(r.href=URL.createObjectURL(e),setTimeout(function(){URL.revokeObjectURL(r.href)},4e4),setTimeout(function(){ds(r)},0))}function gs(e,t=`download`,n){if(typeof e==`string`)if(us(e))ls(e,t,n);else{let t=document.createElement(`a`);t.href=e,t.target=`_blank`,setTimeout(function(){ds(t)})}else navigator.msSaveOrOpenBlob(cs(e,n),t)}function _s(e,t,n,r){if(r||=open(``,`_blank`),r&&(r.document.title=r.document.body.innerText=`downloading...`),typeof e==`string`)return ls(e,t,n);let i=e.type===`application/octet-stream`,a=/constructor/i.test(String(ss.HTMLElement))||`safari`in ss,o=/CriOS\\/[\\d]+/.test(navigator.userAgent);if((o||i&&a||ps)&&typeof FileReader<`u`){let t=new FileReader;t.onloadend=function(){let e=t.result;if(typeof e!=`string`)throw r=null,Error(`Wrong reader.result type`);e=o?e:e.replace(/^data:[^;]*;/,`data:attachment/file;`),r?r.location.href=e:location.assign(e),r=null},t.readAsDataURL(e)}else{let t=URL.createObjectURL(e);r?r.location.assign(t):location.href=t,r=null,setTimeout(function(){URL.revokeObjectURL(t)},4e4)}}var{assign:vs}=Object;function ys(){let e=ve(!0),t=e.run(()=>G({})),n=[],r=[],i=Lt({install(e){rs(i),i._a=e,e.provide(is,i),e.config.globalProperties.$pinia=i,r.forEach(e=>n.push(e)),r=[]},use(e){return this._a?n.push(e):r.push(e),this},_p:n,_a:null,_e:e,_s:new Map,state:t});return i}var bs=()=>{};function xs(e,t,n,r=bs){e.add(t);let i=()=>{e.delete(t)&&r()};return!n&&ye()&&be(i),i}function Ss(e,...t){e.forEach(e=>{e(...t)})}var Cs=e=>e(),ws=Symbol(),Ts=Symbol();function Es(e,t){e instanceof Map&&t instanceof Map?t.forEach((t,n)=>e.set(n,t)):e instanceof Set&&t instanceof Set&&t.forEach(e.add,e);for(let n in t){if(!t.hasOwnProperty(n))continue;let r=t[n],i=e[n];as(i)&&as(r)&&e.hasOwnProperty(n)&&!W(r)&&!Nt(r)?e[n]=Es(i,r):e[n]=r}return e}var Ds=Symbol();function Os(e){return!as(e)||!Object.prototype.hasOwnProperty.call(e,Ds)}var{assign:ks}=Object;function As(e){return!!(W(e)&&e.effect)}function js(e,t,n,r){let{state:i,actions:a,getters:o}=t,s=n.state.value[e],c;function l(){return s||(n.state.value[e]=i?i():{}),ks(Wt(n.state.value[e]),a,Object.keys(o||{}).reduce((t,r)=>(t[r]=Lt($(()=>{rs(n);let t=n._s.get(e);return o[r].call(t,t)})),t),{}))}return c=Ms(e,l,t,n,r,!0),c}function Ms(e,t,n={},r,i,a){let o,s=ks({actions:{}},n),c={deep:!0},l,u,d=new Set,f=new Set,p=r.state.value[e];!a&&!p&&(r.state.value[e]={});let m;function h(t){let n;l=u=!1,typeof t==`function`?(t(r.state.value[e]),n={type:os.patchFunction,storeId:e,events:void 0}):(Es(r.state.value[e],t),n={type:os.patchObject,payload:t,storeId:e,events:void 0});let i=m=Symbol();pn().then(()=>{m===i&&(l=!0)}),u=!0,Ss(d,n,r.state.value[e])}let g=a?function(){let{state:e}=n,t=e?e():{};this.$patch(e=>{ks(e,t)})}:bs;function _(){o.stop(),d.clear(),f.clear(),r._s.delete(e)}let v=(t,n=``)=>{if(ws in t)return t[Ts]=n,t;let i=function(){rs(r);let n=Array.from(arguments),a=new Set,o=new Set;function s(e){a.add(e)}function c(e){o.add(e)}Ss(f,{args:n,name:i[Ts],store:y,after:s,onError:c});let l;try{l=t.apply(this&&this.$id===e?this:y,n)}catch(e){throw Ss(o,e),e}return l instanceof Promise?l.then(e=>(Ss(a,e),e)).catch(e=>(Ss(o,e),Promise.reject(e))):(Ss(a,l),l)};return i[ws]=!0,i[Ts]=n,i},y=kt({_p:r,$id:e,$onAction:xs.bind(null,f),$patch:h,$reset:g,$subscribe(t,n={}){let i=xs(d,t,n.detached,()=>a()),a=o.run(()=>Nn(()=>r.state.value[e],r=>{(n.flush===`sync`?u:l)&&t({storeId:e,type:os.direct,events:void 0},r)},ks({},c,n)));return i},$dispose:_});r._s.set(e,y);let b=(r._a&&r._a.runWithContext||Cs)(()=>r._e.run(()=>(o=ve()).run(()=>t({action:v}))));for(let t in b){let n=b[t];W(n)&&!As(n)||Nt(n)?a||(p&&Os(n)&&(W(n)?n.value=p[t]:Es(n,p[t])),r.state.value[e][t]=n):typeof n==`function`&&(b[t]=v(n,t),s.actions[t]=n)}return ks(y,b),ks(U(y),b),Object.defineProperty(y,`$state`,{get:()=>r.state.value[e],set:e=>{h(t=>{ks(t,e)})}}),r._p.forEach(e=>{ks(y,o.run(()=>e({store:y,app:r._a,pinia:r,options:s})))}),p&&a&&n.hydrate&&n.hydrate(y.$state,p),l=!0,u=!0,y}function Ns(e,t,n){let r,i=typeof t==`function`;r=i?n:t;function a(n,a){let o=An();return n||=o?kn(is,null):null,n&&rs(n),n=ns,n._s.has(e)||(i?Ms(e,t,r,n):js(e,r,n)),n._s.get(e)}return a.$id=e,a}var Ps=()=>window.location,Fs=e=>(Ps().protocol===`https:`?`wss://`:`ws://`)+Ps().host+`/ws?room=`+encodeURIComponent(e),Is=e=>`pidor:session:`+e,Ls,Rs,zs,Bs,Vs,Hs=0,Us=!1,Ws=!1,Gs=null;const Ks=Ns(`game`,{state:()=>({socket:null,connected:!1,playerId:``,playerName:``,roomId:``,gameState:null,lastPenalty:null,lastVerdict:null,lastReveal:null,lastError:``,tables:[],roomsLoading:!1}),actions:{connect(){},async fetchTables(){this.roomsLoading=!0;try{let e=await fetch(`/api/rooms`,{cache:`no-store`});if(!e.ok)throw Error(`Не удалось получить столы`);let t=await e.json();this.tables=Array.isArray(t.tables)?t.tables.filter(e=>e.phase===`LOBBY`&&e.visibility===`public`&&e.seats>0&&e.seats<e.capacity):[]}catch(e){this.lastError=e instanceof Error?e.message:`Ошибка загрузки`}finally{this.roomsLoading=!1}},async createTable(e){try{let t=await fetch(`/api/rooms`,{method:`POST`,headers:{\"content-type\":`application/json`},body:JSON.stringify(e)}),n=await t.json();if(!t.ok||!n.table)throw Error(n.error||`Не удалось создать стол`);return n.table}catch(e){return this.lastError=e instanceof Error?e.message:`Ошибка`,null}},joinRoom(e,t,n={}){if(!/^[A-Za-z0-9_-]{1,48}$/.test(t)){this.lastError=`Код стола может содержать только латинские буквы, цифры, _ и -`;return}Gs={name:e,room:t,options:n},Us=!1,this.roomId=t,this.playerName=e,this.gameState=null,this.lastError=``,this.openWebSocket()},openWebSocket(){if(!Gs||!navigator.onLine)return;Ws||(Ws=!0,window.addEventListener(`online`,()=>{!Us&&Gs&&this.socket?.readyState!==WebSocket.OPEN&&this.openWebSocket()}),document.addEventListener(`visibilitychange`,()=>{document.visibilityState===`visible`&&!Us&&Gs&&this.socket?.readyState!==WebSocket.OPEN&&navigator.onLine&&this.openWebSocket()}));let{room:e,name:t,options:n}=Gs,r=this.socket;r&&(r.onclose=null,r.close()),clearTimeout(Ls),clearInterval(Rs);let i=new WebSocket(Fs(e));this.socket=i,this.connected=!1,i.onopen=()=>{if(this.socket!==i)return;this.connected=!0;let r=window.Telegram?.WebApp?.initData,a=localStorage.getItem(Is(e))||void 0,o={playerName:t,...n,...r?{initData:r}:{},...a?{sessionToken:a}:{}};i.send(JSON.stringify({type:`joinRoom`,data:o})),Rs=setInterval(()=>{i.readyState===WebSocket.OPEN&&i.send(JSON.stringify({type:`ping`,data:{}}))},23e3)},i.onmessage=t=>{if(this.socket!==i)return;let n;try{n=JSON.parse(t.data)}catch{return}let r=n.data;switch(n.type){case`joined`:{let t=r;Hs=0,this.playerId=t.playerId,this.playerName=t.name,localStorage.setItem(Is(e),t.sessionToken);break}case`gameStateUpdate`:this.gameState=r;break;case`cardDrawReveal`:{let e=r;this.lastReveal=e,clearTimeout(Vs),Vs=setTimeout(()=>{this.lastReveal?.id===e.id&&(this.lastReveal=null)},1500);break}case`penalty`:{let e=r;this.lastPenalty=e,clearTimeout(zs),zs=setTimeout(()=>{this.lastPenalty===e&&(this.lastPenalty=null)},2100);break}case`accusationVerdict`:{let e=r;this.lastVerdict=e,clearTimeout(Bs),Bs=setTimeout(()=>{this.lastVerdict===e&&(this.lastVerdict=null)},2100);break}case`actionError`:case`joinError`:this.lastError=String(r),n.type===`joinError`&&(Us=!0,i.close()),setTimeout(()=>{this.lastError===String(r)&&(this.lastError=``)},4e3);break}},i.onclose=()=>{this.socket===i&&(clearInterval(Rs),this.connected=!1,!Us&&Gs&&navigator.onLine&&(Hs++,Ls=setTimeout(()=>this.openWebSocket(),Math.min(2e4,700*1.65**Math.min(Hs,9))+Math.random()*350)))},i.onerror=()=>{this.socket===i&&(this.lastError=`Соединение прервано`)}},disconnect(){Us=!0,Gs=null,Hs=0,clearTimeout(Ls),clearInterval(Rs),this.socket?.close(),this.socket=null,this.connected=!1,this.playerId=``,this.gameState=null},send(e,t={}){return!this.socket||this.socket.readyState!==WebSocket.OPEN||!this.playerId?!1:(this.socket.send(JSON.stringify({type:e,data:{...t,actionId:crypto.randomUUID()}})),!0)},startGame(){return this.send(`startGame`)},drawCardFromDeck(){return this.send(`drawCardFromDeck`)},drawTo(e){return this.send(`drawTo`,{targetPlayerId:e})},takeFromPile(e){return this.send(`takeFromPile`,{cardId:e})},moveTopTo(e){return this.send(`moveTopTo`,{targetPlayerId:e})},placeActiveCard(e){return this.send(`placeActiveCard`,{targetPlayerId:e})},givePenaltyCard(e,t){return this.send(`givePenaltyCard`,{cardId:e,receiverId:t})},playCard(e){return this.send(`playCard`,{cardId:e})},takeTrick(){return this.send(`takeTrick`)},takeStumps(){return this.send(`takeStumps`)},exitGame(){return this.send(`exitGame`)},accusePlayer(e){return this.send(`accusePlayer`,{accusedId:e})},finishReview(){return this.send(`finishReview`)},sayPhrase(e){return this.send(`sayPhrase`,{phrase:e})}}});var qs=[`data-card-id`],Js=[`src`],Ys={key:1,class:`playing-card__fallback-back`},Xs={key:2,class:`playing-card__fallback-front`},Zs=er({__name:`CardComponent`,props:{card:{},hidden:{type:Boolean,default:!1},small:{type:Boolean,default:!1},inert:{type:Boolean,default:!1}},setup(e){let t=e,n=G(!1),r={6:`6`,7:`7`,8:`8`,9:`9`,10:`10`,J:`В`,Q:`Д`,K:`К`,A:`Т`},i={hearts:`♥`,diamonds:`♦`,clubs:`♣`,spades:`♠`},a={hearts:`H`,diamonds:`D`,clubs:`C`,spades:`S`},o=$(()=>t.hidden||!t.card?`/cards/BACK_COMMON.webp`:`/cards/`+(/^[0-9]$/.test(t.card.rank)?`0`+t.card.rank:t.card.rank===`10`?`10`:t.card.rank)+`_`+a[t.card.suit]+`.webp`),s=$(()=>t.card?.suit===`hearts`||t.card?.suit===`diamonds`);return(t,a)=>(J(),Y(`div`,{class:N([`playing-card`,{\"playing-card--small\":e.small,\"playing-card--back\":e.hidden,\"playing-card--red\":s.value,\"playing-card--inert\":e.inert}]),\"data-card-id\":e.card?.id,\"aria-hidden\":`true`},[n.value?e.hidden||!e.card?(J(),Y(`div`,Ys,[...a[1]||=[X(`i`,null,`✦`,-1)]])):(J(),Y(`div`,Xs,[X(`b`,null,L(r[e.card.rank]),1),X(`strong`,null,L(i[e.card.suit]),1),X(`b`,null,L(r[e.card.rank]),1)])):(J(),Y(`img`,{key:0,src:o.value,alt:``,draggable:`false`,onError:a[0]||=e=>n.value=!0},null,40,Js))],10,qs))}}),Qs=[`data-seat-id`],$s={class:`seat__identity`},ec={key:0,class:`seat__turn`,\"aria-label\":`Ход игрока`},tc={class:`seat__name`},nc=[`aria-label`],rc={key:0,class:`seat__pile-card`},ic={key:1,class:`seat__closed-hand`},ac={key:0,class:`seat__count`},oc={key:1,class:`seat__count`},sc={key:2,class:`seat__status`},cc=er({__name:`PlayerSeat`,props:{player:{},isMe:{type:Boolean,default:!1},isTurn:{type:Boolean,default:!1},phase:{},underlaidCards:{type:Boolean,default:!0},selectedCardId:{default:null},hiddenCardIds:{}},emits:[`cardClick`,`click`],setup(e,{emit:t}){let n=e,r=t,i=$(()=>n.player.stumps[n.player.stumps.length-1]),a=$(()=>n.player.stumps.filter(e=>!n.hiddenCardIds?.has(e.id))),o=$(()=>n.player.hand.length),s=$(()=>n.underlaidCards?2:0),c=$(()=>n.phase===`DEALING`||n.phase===`PENALTY_REVIEW`);function l(e){e.stopPropagation(),i.value&&!n.hiddenCardIds?.has(i.value.id)&&r(`cardClick`,{card:i.value,ownerId:n.player.id})}return(t,n)=>(J(),Y(`div`,{class:N([`seat`,{\"seat--me\":e.isMe,\"seat--active\":e.isTurn,\"seat--exited\":e.player.hasExited}]),\"data-seat-id\":e.player.id,onClick:n[0]||=e=>r(`click`)},[X(`div`,$s,[e.isTurn?(J(),Y(`span`,ec,`◆`)):Q(``,!0),X(`span`,tc,L(e.player.name),1),e.player.penalties?(J(),Y(`span`,{key:1,class:`seat__penalties`,\"aria-label\":`Похуёвых: `+e.player.penalties},`☠ `+L(e.player.penalties),9,nc)):Q(``,!0)]),X(`div`,{class:`seat__cards`,onClick:Ko(l,[`stop`])},[c.value?(J(!0),Y(q,{key:0},Tr(a.value,(e,t)=>(J(),Y(`div`,{key:e.id,class:`seat__pile-card`,style:M({transform:`translate(`+t*1.2+`px,`+-t*1.2+`px)`,zIndex:t})},[Z(Zs,{card:e,hidden:e.id.startsWith(`masked-`)||t<s.value,small:``},null,8,[`card`,`hidden`])],4))),128)):(J(),Y(q,{key:1},[e.player.stumps.length?(J(),Y(`div`,rc,[Z(Zs,{card:e.player.stumps[e.player.stumps.length-1],hidden:!e.isMe,small:``},null,8,[`card`,`hidden`])])):Q(``,!0),!e.isMe&&o.value>0?(J(),Y(`div`,ic,[Z(Zs,{hidden:``,small:``})])):Q(``,!0)],64))]),e.phase===`DEALING`?(J(),Y(`span`,ac,L(a.value.length)+` / `+L(e.player.stumps.length),1)):e.isMe?Q(``,!0):(J(),Y(`span`,oc,L(o.value)+` карт`,1)),e.player.hasExited?(J(),Y(`span`,sc,`Вышел`)):Q(``,!0)],10,Qs))}}),lc=er({__name:`HandFan`,props:{cards:{},disabled:{type:Boolean,default:!1},allowSeatDrop:{type:Boolean,default:!1},selectedCardId:{default:null}},emits:[`play`,`give`,`choose`,`select`,`hover`],setup(e,{emit:t}){let n=e,r=t,i=G(null),a=G(-1),o=G(null),s=G(0),c=G(0),l=G({x:0,y:0}),u=G(!1),d=G(!1),f=G(!1),p=G(!1),m=[],h,g,_=G(360),v=$(()=>Math.max(5,Math.min(62,(_.value-84)/Math.max(n.cards.length-1,1)))),y=$(()=>n.cards.length?84+(n.cards.length-1)*v.value:0),b=$(()=>n.cards[a.value]??null);function x(e){return(e-(n.cards.length-1)/2)*v.value}function S(e){return Math.max(-18,Math.min(18,(e-(n.cards.length-1)/2)*3.4))}function C(e){let t=i.value?.getBoundingClientRect();if(!t||!n.cards.length)return-1;let r=e-(t.left+t.width/2);return Math.max(0,Math.min(n.cards.length-1,Math.round(r/v.value+(n.cards.length-1)/2)))}function w(e,t){for(let n of document.elementsFromPoint(e,t)){let e=n.closest(`[data-seat-id]`);if(e?.dataset.seatId)return e.dataset.seatId}return null}function T(e,t){return n.allowSeatDrop?!!w(e,t):!!document.elementFromPoint(e,t)?.closest(`[data-drop-zone=\"trick\"]`)}function ee(e){n.disabled||p.value||o.value!==null||!n.cards.length||e.pointerType===`mouse`&&e.button!==0||(o.value=e.pointerId,s.value=e.clientX,c.value=e.clientY,l.value={x:e.clientX,y:e.clientY},m.length=0,m.push({x:e.clientX,y:e.clientY,t:performance.now()}),a.value=C(e.clientX),e.currentTarget.setPointerCapture(e.pointerId),r(`select`),e.preventDefault())}function E(e){if(e.pointerId!==o.value)return;l.value={x:e.clientX,y:e.clientY};let t=performance.now();for(m.push({x:e.clientX,y:e.clientY,t});m.length>2&&m[0].t<t-110;)m.shift();if(u.value||(c.value-e.clientY>30?u.value=!0:Math.abs(c.value-e.clientY)<24&&(a.value=C(e.clientX))),u.value){let t=T(e.clientX,e.clientY);f.value!==t&&(f.value=t,r(`hover`,t))}e.preventDefault()}function D(e){if(o.value!==e.pointerId)return;let t=n.allowSeatDrop?w(e.clientX,e.clientY):null,s=m[0],g=s?Math.max(1,performance.now()-s.t):999,_=s?(e.clientY-s.y)/g:0,v=s?(e.clientX-s.x)/g:0,y=!n.allowSeatDrop&&u.value&&_<-.85&&Math.abs(_)>Math.abs(v)*.8&&e.clientY<c.value-45,x=u.value&&!n.disabled&&(n.allowSeatDrop?!!t:T(e.clientX,e.clientY)||y)&&b.value,S=!u.value&&n.allowSeatDrop&&b.value;if(o.value=null,f.value=!1,r(`hover`,!1),x&&b.value){p.value=!0;let e=(t?document.querySelector(`[data-seat-id=\"`+CSS.escape(t)+`\"] .seat__cards`):document.querySelector(`.table__trick`))?.getBoundingClientRect();e&&(d.value=!0,l.value={x:e.left+e.width/2,y:e.top+e.height/2}),n.allowSeatDrop&&t?r(`give`,b.value,t):r(`play`,b.value),clearTimeout(h),h=setTimeout(O,450)}else if(S&&b.value)r(`choose`,b.value),O();else if(u.value){let e=(i.value?.querySelectorAll(`.hand-fan__slot`)[a.value])?.getBoundingClientRect();e?(d.value=!0,l.value={x:e.left+e.width/2,y:e.top+e.height/2},clearTimeout(h),h=setTimeout(O,240)):O()}else O();e.currentTarget.hasPointerCapture(e.pointerId)&&e.currentTarget.releasePointerCapture(e.pointerId)}function O(){o.value=null,u.value=!1,d.value=!1,f.value=!1,r(`hover`,!1),p.value=!1,a.value=-1,m.length=0}function k(e){o.value===e.pointerId&&O()}return hr(()=>{i.value&&(_.value=i.value.clientWidth,g=new ResizeObserver(e=>{_.value=e[0]?.contentRect.width??_.value}),g.observe(i.value))}),vr(()=>{clearTimeout(h),g?.disconnect()}),(t,n)=>(J(),Y(`div`,{ref_key:`root`,ref:i,class:N([`hand-fan`,{\"hand-fan--disabled\":e.disabled}]),\"aria-label\":`Ваши карты. Проведите пальцем для выбора, потяните вверх для хода`,onPointerdown:ee,onPointermove:E,onPointerup:D,onPointercancel:k,onLostpointercapture:n[0]||=e=>{e.pointerId===o.value&&O()}},[X(`div`,{class:`hand-fan__cards`,style:M({width:y.value+`px`})},[(J(!0),Y(q,null,Tr(e.cards,(t,n)=>(J(),Y(`div`,{key:t.id,class:N([`hand-fan__slot`,{\"hand-fan__slot--active\":n===a.value||a.value<0&&t.id===e.selectedCardId,\"hand-fan__slot--dragging\":u.value&&n===a.value}]),style:M({\"--fan-x\":x(n)+`px`,\"--fan-angle\":S(n)+`deg`,zIndex:n===a.value?e.cards.length+1:n})},[Z(Zs,{card:t},null,8,[`card`])],6))),128))],4),u.value&&b.value?(J(),Y(`div`,{key:0,class:N([`hand-fan__ghost`,{\"hand-fan__ghost--snap\":d.value,\"hand-fan__ghost--over\":f.value}]),style:M({left:l.value.x+`px`,top:l.value.y+`px`})},[Z(Zs,{card:b.value},null,8,[`card`])],6)):Q(``,!0)],34))}});function uc(e){return(Number.isFinite(e)?Math.max(0,e):0)+`px`}function dc(){let e=window.Telegram?.WebApp;if(e){try{e.expand?.()}catch{}try{e.disableVerticalSwipes?.()}catch{}try{e.requestFullscreen?.()}catch{}}}function fc(){let e=window.Telegram?.WebApp,t=document.documentElement;e&&t.classList.add(`telegram-mini-app`);let n=0,r=0,i=()=>{cancelAnimationFrame(n),n=requestAnimationFrame(()=>{let n=e?.safeAreaInset||{},i=e?.contentSafeAreaInset||{};t.style.setProperty(`--tg-safe-top`,uc(Math.max(n.top||0,i.top||0,e?96:0))),t.style.setProperty(`--tg-safe-bottom`,uc(Math.max(n.bottom||0,i.bottom||0))),t.style.setProperty(`--tg-safe-left`,uc(Math.max(n.left||0,i.left||0))),t.style.setProperty(`--tg-safe-right`,uc(Math.max(n.right||0,i.right||0)));let a=e?.viewportStableHeight||e?.viewportHeight||window.visualViewport?.height||window.innerHeight;a&&Math.abs(a-r)>=1&&(r=a,t.style.setProperty(`--app-vh`,Math.round(a)+`px`))})};try{e?.ready?.()}catch{}return dc(),i(),window.addEventListener(`resize`,i,{passive:!0}),window.visualViewport?.addEventListener(`resize`,i,{passive:!0}),e?.onEvent?.(`viewportChanged`,i),e?.onEvent?.(`safeAreaChanged`,i),e?.onEvent?.(`contentSafeAreaChanged`,i),e?.onEvent?.(`fullscreenChanged`,i),()=>{cancelAnimationFrame(n),t.classList.remove(`telegram-mini-app`),window.removeEventListener(`resize`,i),window.visualViewport?.removeEventListener(`resize`,i),e?.offEvent?.(`viewportChanged`,i),e?.offEvent?.(`safeAreaChanged`,i),e?.offEvent?.(`contentSafeAreaChanged`,i),e?.offEvent?.(`fullscreenChanged`,i)}}var pc={class:`app-shell`},mc={class:`game-bar`},hc={class:`game-bar__meta`},gc={class:`game-bar__actions`},_c=[`aria-label`],vc={key:0,class:`lobby`},yc={class:`lobby__panel`},bc={class:`lobby__subtitle`},xc={class:`profile__metrics`},Sc={class:`profile__history`},Cc={key:0,class:`lobby__subtitle`},wc={key:1,class:`lobby`},Tc={class:`lobby__panel`},Ec={class:`lobby__tabs`},Dc={key:0,class:`lobby__stack`},Oc=[`onClick`],kc={key:0,class:`lobby__subtitle`},Ac={key:1,class:`lobby__stack`},jc={class:`lobby__checkbox`},Mc={class:`lobby__checkbox`},Nc={key:3,class:`lobby__stack`},Pc={class:`lobby__checkbox`},Fc={class:`lobby__subtitle`},Ic={key:2,class:`lobby`},Lc={class:`lobby__panel`},Rc={class:`lobby__people`},zc={key:1,class:`lobby__subtitle`},Bc={class:`lobby__subtitle`},Vc={key:3,class:`game-viewport`},Hc={class:`table`},Uc={key:0,class:`table__seat table__seat--self`},Wc=[`aria-label`,`onKeydown`],Gc={class:`table__deck-count`},Kc={key:3,class:`table__discard`},qc={class:`table__discard-num`},Jc={key:5,class:`table__target-hint`},Yc={class:`hand-area__actions`},Xc=[`disabled`],Zc={key:0},Qc={key:0,class:`hand-area__label`},$c={key:0,class:`end-screen`,\"aria-live\":`polite`},el={key:0},tl={class:`end-screen__scores`},nl={key:4,class:`lobby`},rl={class:`lobby__panel`,role:`status`},il={class:`lobby__subtitle`},al={key:0,class:`lobby__subtitle`},ol={key:0,class:`toast`,role:`status`},sl={class:`card-flight__body`},cl=`pidor:profile:v1`,ll=Qo(er({__name:`App`,setup(e){let t=Ks(),n=G(``),r=G(`pidor-1`),i=G(!1);function a(){try{let e=JSON.parse(localStorage.getItem(cl)||`[]`);return Array.isArray(e)?e.filter(e=>typeof e==`object`&&!!e&&typeof e.at==`number`&&typeof e.room==`string`&&(e.result===`finished`||e.result===`last`)).slice(0,30):[]}catch{return[]}}let o=G(a()),s=G(!1),c=$(()=>o.value.length),l=$(()=>o.value.filter(e=>e.result===`finished`).length),u=$(()=>o.value.reduce((e,t)=>e+t.penalties,0)),d=``;function f(){if(!P.value||P.value.phase!==`ENDED`||!F.value||!t.roomId)return;let e=`pidor:recorded:`+t.roomId+`:`+t.playerId;d===e||localStorage.getItem(e)||(d=e,o.value=[{room:t.roomId,at:Date.now(),players:P.value.players.length,penalties:F.value.penalties,result:F.value.onDuty?`last`:`finished`},...o.value].slice(0,30),localStorage.setItem(cl,JSON.stringify(o.value)),localStorage.setItem(e,`1`))}let p=G(!0),m=G(3),h=G(`free`),g=G(!0),_=G(`Стол у камина`),v=G(null),y=G(Date.now()),b,x=G(localStorage.getItem(`pidor:sound`)!==`off`),S=window.matchMedia(`(prefers-reduced-motion: reduce)`).matches,C=G(null),w=G(!1),T=G(null),ee=G(null),E=G(null),D=G({x:-200,y:-200}),O=G(null),k=0;function te(e,t,n){if(S)return;let r=++k;O.value={id:r,x:t,y:n,kind:e},setTimeout(()=>{O.value?.id===r&&(O.value=null)},530)}let A=G(new Set),ne=G(new Set),re=G(null),j=G(null),ie=G(!1),ae=G(!1),oe=G({x:0,y:0}),se=G(null),ce=G(!1),le=G(null),ue=G(``),de,fe,pe,me=null,he=0,P=$(()=>t.gameState),F=$(()=>P.value?.players.find(e=>e.id===t.playerId)),I=$(()=>P.value?.players[P.value.turnIndex]?.id===t.playerId),R=$(()=>P.value?.phase||``),ge=$(()=>({LOBBY:`Ожидание`,DEALING:`Раскладка`,PENALTY_REVIEW:`Проверка`,PENALTY_DISTRIBUTION:`Похуёвые`,MAIN_GAME:`Основная игра`,ENDED:`Финал`})[R.value]||``),z=$(()=>{if(!P.value||!F.value)return[];let e=P.value.players,t=e.findIndex(e=>e.id===F.value?.id);return[...e.slice(t+1),...e.slice(0,t)]}),_e={0:[],1:[`top-center`],2:[`top-left`,`top-right`],3:[`left`,`top-center`,`right`],4:[`left`,`top-left`,`top-right`,`right`],5:[`left`,`top-left`,`top-center`,`top-right`,`right`]},ve=$(()=>z.value.map((e,t)=>({player:e,slot:(_e[z.value.length]??_e[5])[t]}))),ye=$(()=>R.value===`DEALING`&&I.value&&!P.value?.activeCard&&!w.value&&!le.value&&!(P.value?.initialDealEndsAt&&y.value<P.value.initialDealEndsAt)),be=$(()=>R.value===`MAIN_GAME`&&I.value&&!w.value&&!le.value),B=$(()=>Math.max(0,Math.ceil(((P.value?.reviewDeadlineAt||y.value)-y.value)/1e3))),xe=$(()=>P.value?.players.find(e=>e.onDuty)||null),Se=$(()=>{let e=P.value,n=F.value;if(!e||!n)return``;let r=e.pendingPenaltyTurn?.receiverId;return e.phase===`PENALTY_DISTRIBUTION`&&e.pendingPenaltyTurn?.giverId===t.playerId?`Передай карту: `+(e.players.find(e=>e.id===r)?.name||`игроку`):n.name+` · `+n.hand.length+` карт`}),Ce=$(()=>P.value?.activeCard),we={hearts:`♥`,diamonds:`♦`,clubs:`♣`,spades:`♠`},Te=$(()=>P.value?.trumpSuit===`diamonds`||P.value?.trumpSuit===`hearts`),Ee=$(()=>P.value?.players.find(e=>e.id===t.lastPenalty?.playerId)?.name||`Игрок`),De=$(()=>{let e=P.value?.players;return e?.length?e[(P.value.turnIndex+1)%e.length]:null}),Oe=$(()=>{let e=ve.value.find(e=>e.player.id===(P.value?.trickTargetId||De.value?.id))?.slot??`bottom`,t={left:{left:`23%`,top:`45%`},\"top-left\":{left:`32%`,top:`32%`},\"top-center\":{left:`50%`,top:`31%`},\"top-right\":{left:`68%`,top:`32%`},right:{left:`76%`,top:`45%`},bottom:{left:`50%`,top:`69%`}};return t[e]||t.bottom});function ke(e){if(x.value)try{me??=new AudioContext,me.state===`suspended`&&me.resume();let t=me.currentTime,n=me.createOscillator(),r=me.createGain(),i={draw:370,drop:235,turn:510,select:630,penalty:190}[e];n.type=e===`penalty`?`triangle`:`sine`,n.frequency.setValueAtTime(i,t),n.frequency.exponentialRampToValueAtTime(i*.78,t+.09),r.gain.setValueAtTime(1e-4,t),r.gain.exponentialRampToValueAtTime(e===`select`?.006:.022,t+.01),r.gain.exponentialRampToValueAtTime(1e-4,t+.13),n.connect(r).connect(me.destination),n.start(t),n.stop(t+.14)}catch{}}function Ae(){x.value=!x.value,localStorage.setItem(`pidor:sound`,x.value?`on`:`off`),ke(`select`)}function V(e){clearTimeout(de),ue.value=e,de=setTimeout(()=>{ue.value=``},2e3)}function je(e,a={}){if(!n.value.trim()){V(`Введи имя`);return}if(!/^[a-zA-Z0-9_-]{1,48}$/.test(e)){V(`Неверный код комнаты`);return}r.value=e,dc(),t.joinRoom(n.value.trim(),e,a),i.value=!0,localStorage.setItem(`pidor:name`,n.value.trim()),window.history.replaceState(null,``,`?room=`+encodeURIComponent(e)),ke(`turn`)}function Me(){je(r.value.trim(),{mode:`friends`,underlaidCards:p.value})}function Ne(){je(`bot_`+crypto.randomUUID().replace(/-/g,``).slice(0,14),{mode:`bot`,botCount:m.value,underlaidCards:p.value})}async function Pe(){if(!n.value.trim()){V(`Введи имя`);return}let e=await t.createTable({title:_.value,visibility:g.value?`public`:`private`,underlaidCards:p.value});if(!e){V(t.lastError||`Ошибка создания стола`);return}je(e.id,{mode:`friends`,underlaidCards:e.underlaidCards})}async function Fe(){let e=new URL(location.href);e.searchParams.set(`room`,r.value);let t=`Сыграем в PIDOR ONLINE? `+e.toString();try{navigator.share?await navigator.share({title:`PIDOR ONLINE`,text:t,url:e.toString()}):navigator.clipboard?(await navigator.clipboard.writeText(t),V(`Ссылка скопирована`)):V(`Код стола: `+r.value)}catch{}}function Ie(){t.disconnect(),i.value=!1,C.value=null,window.history.replaceState(null,``,location.pathname),t.fetchTables()}function Le(){if(!v.value)return V(`Выбери подозреваемого`);let e=v.value;V(`☠ ПОХУЁВАЯ!`),ke(`penalty`),te(`penalty`,window.innerWidth/2,window.innerHeight*.44),Re(`accuse:`+e,()=>t.accusePlayer(e)),v.value=null}function Re(e,t){le.value||w.value||(le.value=e,t(),clearTimeout(fe),fe=setTimeout(()=>{le.value=null},800))}function ze(e){be.value&&(ke(`drop`),Re(`play:`+e.id,()=>t.playCard(e.id)))}function Be(e){!Ce.value||!I.value||w.value&&R.value!==`DEALING`||(ke(`drop`),te(`play`,oe.value.x||window.innerWidth/2,oe.value.y||window.innerHeight/2),Re(`place:`+Ce.value.card.id,()=>t.placeActiveCard(e)),ae.value=!1,se.value=null)}function Ve({card:e,ownerId:n}){if(R.value===`DEALING`){if(Ce.value)return Be(n);if(!I.value||n!==F.value?.id||ne.value.has(e.id)||(F.value?.stumps.length||0)<=(P.value?.underlaidCards===!1?1:3))return;Re(`take:`+e.id,()=>t.takeFromPile(e.id))}else R.value===`PENALTY_DISTRIBUTION`&&n===F.value?.id&&(C.value=e,ke(`select`))}function He(e,n){if(R.value!==`PENALTY_DISTRIBUTION`)return;let r=P.value?.pendingPenaltyTurn;if(r?.giverId!==t.playerId||r.receiverId!==n){V(`Сейчас карта предназначена другому игроку`);return}Re(`penalty:`+e.id,()=>t.givePenaltyCard(e.id,n)),C.value=null,ke(`drop`)}function Ue(e){if(R.value===`DEALING`&&Ce.value){Be(e);return}if(R.value===`PENALTY_DISTRIBUTION`&&C.value){He(C.value,e);return}e!==t.playerId&&(v.value=e)}function We(){ye.value&&(ke(`draw`),Re(`draw`,()=>t.drawCardFromDeck()))}function Ge(e){ye.value&&(e.pointerType===`mouse`&&e.button!==0||(j.value=e.pointerId,ie.value=!0,oe.value={x:e.clientX,y:e.clientY},We(),e.preventDefault()))}function Ke(e){!Ce.value||!I.value||w.value&&R.value!==`DEALING`||e.pointerType===`mouse`&&e.button!==0||(j.value=e.pointerId,ie.value=!1,ae.value=!0,oe.value={x:e.clientX,y:e.clientY},e.preventDefault())}function H(e){j.value===e.pointerId&&(oe.value={x:e.clientX,y:e.clientY},!ae.value&&ie.value&&Ce.value&&I.value&&!w.value&&(ae.value=!0),ae.value&&(se.value=document.elementsFromPoint(e.clientX,e.clientY).map(e=>e.closest(`[data-seat-id]`)).find(e=>!!e)?.dataset.seatId??null))}function qe(e){if(e.pointerId===j.value){if(ae.value){let t=document.elementsFromPoint(e.clientX,e.clientY).map(e=>e.closest(`[data-seat-id]`)).find(e=>!!e),n=se.value||t?.dataset.seatId;n?Be(n):Ce.value&&V(`Отпусти карту на игроке или нажми на его карты`)}ie.value=!1,j.value=null,ae.value=!1,se.value=null}}function Je(e,t){if(!e)return t;let n=e.getBoundingClientRect();return{x:n.left+n.width/2-42,y:n.top+n.height/2-59}}function Ye(){return Je(T.value?.querySelector(`.playing-card`)??T.value,{x:window.innerWidth/2-42,y:window.innerHeight/2-59})}let Xe=Promise.resolve();function Ze(e,t,n,r){let i=Xe.catch(()=>{}).then(()=>Qe(e,t,n,r));return Xe=i.catch(()=>{}),i}async function Qe(e,t,n,r){let i=r?Je(document.querySelector(`[data-seat-id=\"`+CSS.escape(r)+`\"] .seat__cards`),Ye()):Ye(),a=Je(t?document.querySelector(`[data-seat-id=\"`+CSS.escape(t)+`\"] .seat__cards`):document.querySelector(`.table__active-anchor`),{x:window.innerWidth/2-42,y:window.innerHeight/2-59});D.value=i,E.value={card:e,hidden:!0},await pn();let o=ee.value;if(!o){E.value=null;return}o.style.transform=`translate(`+i.x+`px,`+i.y+`px) scale(.87)`;let s=S?70:420,c=o.animate([{transform:`translate(`+i.x+`px,`+i.y+`px) scale(.87) rotate(-5deg)`,filter:`drop-shadow(0 4px 4px #0004)`},{transform:`translate(`+(i.x+a.x)/2+`px,`+((i.y+a.y)/2-30)+`px) scale(1.09) rotate(2deg)`,filter:`drop-shadow(0 14px 10px #0008)`,offset:.44},{transform:`translate(`+a.x+`px,`+a.y+`px) scale(.59) rotate(0deg)`,filter:`drop-shadow(0 4px 4px #0004)`}],{duration:s,easing:`cubic-bezier(.2,.7,.25,1)`,fill:`forwards`});if(n){o.querySelector(`.card-flight__body`)?.animate([{transform:`rotateY(0deg)`},{transform:`rotateY(88deg)`,offset:.5},{transform:`rotateY(0deg)`}],{duration:s,fill:`forwards`});let t=window.setTimeout(()=>{E.value?.card.id===e.id&&(E.value={card:e,hidden:!1})},s/2);try{await c.finished}catch{}clearTimeout(t),E.value?.card.id===e.id&&(E.value={card:e,hidden:!1})}if(!n)try{await c.finished}catch{}te(t?`draw`:`play`,a.x+42,a.y+59),E.value=null}async function $e(e){let t=++he;w.value=!0,A.value=new Set(e.map(e=>e.card.id)),await pn();for(let n of e){if(t!==he||R.value!==`DEALING`)break;await Ze(n.card,n.target,n.faceUp),A.value=new Set([...A.value].filter(e=>e!==n.card.id)),ke(`drop`),S||await new Promise(e=>setTimeout(e,38))}A.value=new Set,w.value=!1}return Nn(P,(e,t)=>{if(e){if(e.phase===`ENDED`&&f(),e.phase===`DEALING`&&t?.phase!==`DEALING`&&e.initialDealEndsAt&&Date.now()<e.initialDealEndsAt){let t=Math.max(...e.players.map(e=>e.stumps.length),0),n=[],r=new Set;for(let i=0;i<t;i++)for(let t of e.players){let e=t.stumps[i];e&&(n.push({card:e,target:t.id,faceUp:i===(t.stumps.length>=3?2:0)}),i<(t.stumps.length>=3?3:1)&&r.add(e.id))}ne.value=r,n.length&&$e(n)}e.activeCard?.card.id&&e.activeCard.card.id!==t?.activeCard?.card.id&&(ie.value=!1,ae.value=!1,se.value=null,re.value=e.activeCard.card.id,Ze(e.activeCard.card,null,!0,e.activeCard.fromDeck?void 0:e.activeCard.ownerId).finally(()=>{re.value=null})),t?.turnIndex!==e.turnIndex&&e.phase!==`LOBBY`&&ke(`turn`),le.value&&t?.activeCard?.card.id!==e.activeCard?.card.id&&(le.value=null),le.value&&e.phase!==t?.phase&&(le.value=null)}},{flush:`sync`}),Nn(()=>t.lastReveal,e=>{!e||R.value!==`DEALING`||setTimeout(()=>{let t=P.value;if(!t||t.phase!==`DEALING`||t.activeCard?.card.id===e.card.id)return;let n=e.targetPlayerId||e.playerId;(t.players.find(e=>e.id===n)?.stumps||[]).some(t=>t.id===e.card.id)&&(A.value=new Set([...A.value,e.card.id]),Qe(e.card,n,!0).finally(()=>{let t=new Set(A.value);t.delete(e.card.id),A.value=t}))},35)}),Nn(()=>t.lastError,e=>{e&&(V(e),le.value=null)}),Nn(()=>t.lastVerdict,e=>{e&&(V((e.correct?`☠ Нарушение доказано`:`☠ Ложное обвинение`)+` · `+e.reason),ke(`penalty`))}),Nn(()=>t.lastPenalty,e=>{e&&(V(`☠ `+Ee.value+` · `+e.reason),ke(`penalty`))}),hr(()=>{pe=fc(),window.addEventListener(`pointermove`,H,{passive:!0}),window.addEventListener(`pointerup`,qe,{passive:!0}),window.addEventListener(`pointercancel`,qe,{passive:!0}),t.connect(),b=setInterval(()=>{y.value=Date.now()},250),n.value=window.Telegram?.WebApp?.initDataUnsafe?.user?.first_name||localStorage.getItem(`pidor:name`)||``;let e=new URLSearchParams(location.search);e.get(`mode`)===`bot`&&(h.value=`bots`);let i=e.get(`room`);i&&/^[A-Za-z0-9_-]{1,48}$/.test(i)&&(r.value=i,h.value=`code`,n.value.trim()&&localStorage.getItem(`pidor:session:`+i)&&je(i,{mode:`friends`})),t.fetchTables()}),vr(()=>{++he,clearTimeout(de),clearInterval(b),clearTimeout(fe),pe?.(),window.removeEventListener(`pointermove`,H),window.removeEventListener(`pointerup`,qe),window.removeEventListener(`pointercancel`,qe),me?.close()}),(e,a)=>(J(),Y(`main`,pc,[X(`header`,mc,[X(`div`,null,[a[23]||=X(`div`,{class:`brand`},[na(`PIDOR `),X(`strong`,null,`ONLINE`)],-1),X(`div`,hc,L(i.value?ge.value+` · `+r.value:`Карточная игра`),1)]),X(`div`,gc,[X(`button`,{type:`button`,class:`icon-button`,\"aria-label\":`Профиль и история партий`,onClick:a[0]||=e=>s.value=!s.value},`♙`),a[24]||=X(`div`,{class:`stars-placeholder`,title:`Игровые звёзды появятся позже`},[na(`★ 0 `),X(`small`,null,`скоро`)],-1),X(`button`,{class:`icon-button`,type:`button`,\"aria-label\":x.value?`Выключить звук`:`Включить звук`,onClick:Ae},L(x.value?`♫`:`♪̸`),9,_c),i.value?(J(),Y(`button`,{key:0,type:`button`,class:`icon-button`,onClick:Ie,\"aria-label\":`К списку столов`},`⌂`)):Q(``,!0)])]),s.value?(J(),Y(`section`,vc,[X(`div`,yc,[a[28]||=X(`h1`,{class:`lobby__title`},`Мой профиль`,-1),X(`p`,bc,L(n.value||K(t).playerName||`Игрок`),1),X(`div`,xc,[X(`span`,null,[a[25]||=na(`Партий `,-1),X(`b`,null,L(c.value),1)]),X(`span`,null,[a[26]||=na(`Не последний `,-1),X(`b`,null,L(l.value),1)]),X(`span`,null,[a[27]||=na(`Штрафов `,-1),X(`b`,null,L(u.value),1)])]),a[29]||=X(`h2`,{class:`profile__heading`},`Последние партии`,-1),X(`div`,Sc,[(J(!0),Y(q,null,Tr(o.value,e=>(J(),Y(`div`,{key:e.room+e.at,class:`profile__match`},[X(`span`,null,L(e.result===`last`?`☠ Последний`:`✓ Не последний`)+` · `+L(e.players)+` игроков`,1),X(`small`,null,L(new Date(e.at).toLocaleDateString(`ru-RU`))+` · `+L(e.penalties)+` штрафов`,1)]))),128)),o.value.length?Q(``,!0):(J(),Y(`p`,Cc,`Заверши первую партию, чтобы появилась статистика.`))]),a[30]||=X(`p`,{class:`lobby__subtitle`},`История пока хранится на этом устройстве. Синхронизацию с Telegram добавим отдельно.`,-1),X(`button`,{class:`lobby__button`,onClick:a[1]||=e=>s.value=!1},`Вернуться к игре`)])])):i.value?P.value?.phase===`LOBBY`?(J(),Y(`section`,Ic,[X(`div`,Lc,[a[38]||=X(`div`,{class:`lobby__title`},`За столом`,-1),X(`div`,Rc,[(J(!0),Y(q,null,Tr(P.value.players,e=>(J(),Y(`span`,{key:e.id,class:`lobby__person`},`◆ `+L(e.name),1))),128))]),P.value.players.length>=2&&P.value.hostId===K(t).playerId?(J(),Y(`button`,{key:0,class:`lobby__button`,onClick:a[14]||=e=>K(t).startGame()},`Начать партию`)):(J(),Y(`div`,zc,L(P.value.players.length<2?`Ожидаем игроков`:`Ожидаем ведущего`),1)),X(`div`,Bc,`Код стола: `+L(r.value),1),X(`button`,{class:`lobby__secondary`,onClick:Fe},`↗ Пригласить друга`),X(`button`,{class:`lobby__secondary`,onClick:Ie},`Назад`)])])):P.value?(J(),Y(`section`,Vc,[X(`div`,Hc,[(J(!0),Y(q,null,Tr(ve.value,e=>(J(),Y(`div`,{key:e.player.id,class:N([`table__seat`,[`table__seat--`+e.slot,{\"table__seat--target\":se.value===e.player.id||P.value.phase===`PENALTY_DISTRIBUTION`&&P.value.pendingPenaltyTurn?.receiverId===e.player.id}]])},[Z(cc,{player:e.player,phase:P.value.phase,\"underlaid-cards\":P.value.underlaidCards!==!1,\"is-turn\":P.value.players[P.value.turnIndex]?.id===e.player.id,\"hidden-card-ids\":A.value,onClick:t=>Ue(e.player.id),onCardClick:Ve},null,8,[`player`,`phase`,`underlaid-cards`,`is-turn`,`hidden-card-ids`,`onClick`])],2))),128)),F.value&&[`DEALING`,`PENALTY_REVIEW`].includes(P.value.phase)?(J(),Y(`div`,Uc,[Z(cc,{player:F.value,phase:P.value.phase,\"underlaid-cards\":P.value.underlaidCards!==!1,\"is-me\":!0,\"is-turn\":I.value,\"hidden-card-ids\":A.value,onClick:a[15]||=e=>Ue(F.value.id),onCardClick:Ve},null,8,[`player`,`phase`,`underlaid-cards`,`is-turn`,`hidden-card-ids`])])):Q(``,!0),P.value.deck.length?(J(),Y(`div`,{key:1,ref_key:`deckRef`,ref:T,role:`button`,tabindex:`0`,class:N([`table__deck`,{\"table__deck--turn\":ye.value}]),\"aria-label\":`Взять карту из колоды. Осталось `+P.value.deck.length,onPointerdown:Ge,onKeydown:[Jo(Ko(We,[`prevent`]),[`enter`]),Jo(Ko(We,[`prevent`]),[`space`])]},[Z(Zs,{hidden:``}),X(`span`,Gc,L(P.value.deck.length),1)],42,Wc)):Q(``,!0),P.value.phase===`MAIN_GAME`&&P.value.trumpSuit?(J(),Y(`div`,{key:2,class:N([`table__trump`,{\"table__trump--red\":Te.value}])},[a[39]||=na(` Козырь `,-1),X(`b`,null,L(we[P.value.trumpSuit]),1)],2)):Q(``,!0),P.value.discardPile.length?(J(),Y(`div`,Kc,[Z(Zs,{hidden:``,small:``}),X(`div`,qc,L(P.value.discardPile.length),1)])):Q(``,!0),X(`div`,{\"data-drop-zone\":`trick`,class:N([`table__play-target`,{\"table__play-target--enabled\":be.value,\"table__play-target--dragover\":ce.value}])},null,2),X(`div`,{class:`table__trick`,style:M(P.value.phase===`MAIN_GAME`?Oe.value:{})},[(J(!0),Y(q,null,Tr(P.value.currentTrick,(e,t)=>(J(),Y(`div`,{key:e.id,style:M({\"--trick-rot\":t*6-4+`deg`,\"--trick-x\":t*8+`px`,\"--trick-y\":t*-4+`px`})},[Z(Zs,{card:e,small:``},null,8,[`card`])],4))),128))],4),a[40]||=X(`div`,{class:`table__active-anchor`},null,-1),Ce.value&&re.value!==Ce.value.card.id?(J(),Y(`div`,{key:4,class:N([`table__active`,{\"table__active--drag\":ae.value,\"table__active--dealing\":P.value.phase===`DEALING`}]),style:M(ae.value?{\"--drag-x\":oe.value.x+`px`,\"--drag-y\":oe.value.y+`px`}:{}),onPointerdown:Ke},[Z(Zs,{card:Ce.value.card},null,8,[`card`])],38)):Q(``,!0),Ce.value&&!ae.value&&I.value&&P.value.phase===`DEALING`?(J(),Y(`div`,Jc,` Перенеси карту на игрока `)):Q(``,!0)]),X(`footer`,{class:N([`hand-area`,{\"hand-area--fan\":[`MAIN_GAME`,`PENALTY_DISTRIBUTION`].includes(P.value.phase)}])},[X(`div`,Yc,[[`DEALING`,`PENALTY_REVIEW`,`MAIN_GAME`].includes(P.value.phase)?(J(),Y(`button`,{key:0,class:`action-pill action-pill--quiet`,onClick:Le,disabled:!v.value},`☠ ПОХУЁВАЯ! `+L(v.value?P.value.players.find(e=>e.id===v.value)?.name:``),9,Xc)):Q(``,!0),P.value.phase===`PENALTY_REVIEW`?(J(),Y(`button`,{key:1,class:`action-pill action-pill--quiet`,onClick:a[16]||=e=>K(t).finishReview()},[a[41]||=na(`Продолжить `,-1),B.value?(J(),Y(`span`,Zc,`· `+L(B.value)+`с`,1)):Q(``,!0)])):Q(``,!0),P.value.phase===`MAIN_GAME`&&I.value&&P.value.currentTrick.length?(J(),Y(`button`,{key:2,class:`action-pill`,onClick:a[17]||=e=>K(t).takeTrick()},`Забрать`)):Q(``,!0),F.value&&!F.value.hand.length&&F.value.stumps.length&&P.value.phase===`MAIN_GAME`?(J(),Y(`button`,{key:3,class:`action-pill`,onClick:a[18]||=e=>K(t).takeStumps()},`Беру пеньки`)):Q(``,!0),F.value&&!F.value.hand.length&&!F.value.stumps.length&&P.value.phase===`MAIN_GAME`?(J(),Y(`button`,{key:4,class:`action-pill action-pill--quiet`,onClick:a[19]||=e=>K(t).exitGame()},`Выйти`)):Q(``,!0)]),F.value?(J(),Y(`div`,Qc,L(Se.value),1)):Q(``,!0),F.value&&[`MAIN_GAME`,`PENALTY_DISTRIBUTION`].includes(P.value.phase)?(J(),Ji(lc,{key:1,cards:F.value.hand,disabled:P.value.phase===`MAIN_GAME`?!be.value:P.value.pendingPenaltyTurn?.giverId!==K(t).playerId||w.value||!!le.value,\"allow-seat-drop\":P.value.phase===`PENALTY_DISTRIBUTION`,\"selected-card-id\":C.value?.id,onGive:He,onChoose:a[20]||=e=>C.value=e,onPlay:ze,onSelect:a[21]||=e=>ke(`select`),onHover:a[22]||=e=>ce.value=e},null,8,[`cards`,`disabled`,`allow-seat-drop`,`selected-card-id`])):Q(``,!0)],2),Z(Wa,{name:`toast`},{default:Tn(()=>[P.value.phase===`ENDED`?(J(),Y(`section`,$c,[a[42]||=X(`span`,{class:`end-screen__eyebrow`},`Партия завершена`,-1),a[43]||=X(`h2`,null,`Игра окончена`,-1),xe.value?(J(),Y(`p`,el,`☠ `+L(xe.value.name)+` · последний за столом`,1)):Q(``,!0),X(`div`,tl,[(J(!0),Y(q,null,Tr(P.value.players,e=>(J(),Y(`span`,{key:e.id},[na(L(e.name)+` `,1),X(`b`,null,`☠ `+L(e.penalties),1)]))),128))]),X(`button`,{class:`lobby__button`,onClick:Ie},`К новым партиям`)])):Q(``,!0)]),_:1})])):(J(),Y(`section`,nl,[X(`div`,rl,[X(`p`,il,L(K(t).connected?`Подключаемся к столу…`:`Соединяемся с сервером…`),1),K(t).lastError?(J(),Y(`p`,al,L(K(t).lastError),1)):Q(``,!0),X(`button`,{class:`lobby__secondary`,onClick:Ie},`К списку столов`)])])):(J(),Y(`section`,wc,[X(`div`,Tc,[a[35]||=X(`h1`,{class:`lobby__title`},`PIDOR ONLINE`,-1),a[36]||=X(`p`,{class:`lobby__subtitle`},`Игра для своих.`,-1),En(X(`input`,{class:`lobby__field`,\"onUpdate:modelValue\":a[2]||=e=>n.value=e,maxlength:`32`,autocomplete:`nickname`,placeholder:`Имя игрока`,\"aria-label\":`Имя игрока`},null,512),[[zo,n.value]]),X(`div`,Ec,[X(`button`,{class:N({active:h.value===`free`}),onClick:a[3]||=e=>{h.value=`free`,K(t).fetchTables()}},`Свободные`,2),X(`button`,{class:N({active:h.value===`create`}),onClick:a[4]||=e=>h.value=`create`},`Создать`,2),X(`button`,{class:N({active:h.value===`code`}),onClick:a[5]||=e=>h.value=`code`},`По коду`,2),X(`button`,{class:N({active:h.value===`bots`}),onClick:a[6]||=e=>h.value=`bots`},`Боты`,2)]),h.value===`free`?(J(),Y(`div`,Dc,[(J(!0),Y(q,null,Tr(K(t).tables,e=>(J(),Y(`button`,{key:e.id,class:`lobby__room`,onClick:t=>je(e.id,{mode:`friends`,underlaidCards:e.underlaidCards})},[X(`span`,null,L(e.title),1),X(`small`,null,L(e.seats)+`/`+L(e.capacity)+` · `+L(e.underlaidCards?`С подложенными`:`Без подложенных`),1)],8,Oc))),128)),K(t).tables.length?Q(``,!0):(J(),Y(`p`,kc,`Свободных столов пока нет`)),X(`button`,{class:`lobby__secondary`,onClick:a[7]||=e=>K(t).fetchTables()},`↻ Обновить`)])):h.value===`create`?(J(),Y(`div`,Ac,[En(X(`input`,{class:`lobby__field`,\"onUpdate:modelValue\":a[8]||=e=>_.value=e,maxlength:`36`,placeholder:`Название стола`},null,512),[[zo,_.value]]),X(`label`,jc,[En(X(`input`,{type:`checkbox`,\"onUpdate:modelValue\":a[9]||=e=>g.value=e},null,512),[[Bo,g.value]]),a[31]||=na(` Публичный стол`,-1)]),X(`label`,Mc,[En(X(`input`,{type:`checkbox`,\"onUpdate:modelValue\":a[10]||=e=>p.value=e},null,512),[[Bo,p.value]]),a[32]||=na(` Две закрытые карты`,-1)]),X(`button`,{class:`lobby__button`,onClick:Pe},`Создать стол`)])):h.value===`code`?(J(),Y(`form`,{key:2,class:`lobby__stack`,onSubmit:Ko(Me,[`prevent`])},[En(X(`input`,{class:`lobby__field`,\"onUpdate:modelValue\":a[11]||=e=>r.value=e,maxlength:`48`,placeholder:`Код комнаты`,required:``},null,512),[[zo,r.value]]),a[33]||=X(`button`,{class:`lobby__button`,type:`submit`},`Присоединиться`,-1)],32)):(J(),Y(`div`,Nc,[X(`label`,Pc,[En(X(`input`,{type:`checkbox`,\"onUpdate:modelValue\":a[12]||=e=>p.value=e},null,512),[[Bo,p.value]]),a[34]||=na(` Две закрытые карты`,-1)]),X(`label`,Fc,`Ботов: `+L(m.value),1),En(X(`input`,{type:`range`,\"onUpdate:modelValue\":a[13]||=e=>m.value=e,min:`1`,max:`5`},null,512),[[zo,m.value,void 0,{number:!0}]]),X(`button`,{class:`lobby__button`,onClick:Ne},`Играть с ботами`)])),a[37]||=X(`p`,{class:`lobby__subtitle`},`★ Игра на звёзды — скоро`,-1)])])),Z(Wa,{name:`toast`},{default:Tn(()=>[ue.value?(J(),Y(`div`,ol,L(ue.value),1)):Q(``,!0)]),_:1}),O.value?(J(),Y(`div`,{key:O.value.id,class:N([`table-vfx`,`table-vfx--`+O.value.kind]),style:M({left:O.value.x+`px`,top:O.value.y+`px`})},[(J(),Y(q,null,Tr(8,e=>X(`i`,{key:e,style:M({\"--spark-angle\":e*45+`deg`})},null,4)),64))],6)):Q(``,!0),E.value?(J(),Y(`div`,{key:6,ref_key:`flightRef`,ref:ee,class:`card-flight`,style:M({transform:`translate(${D.value.x}px, ${D.value.y}px) scale(.87)`})},[X(`div`,sl,[Z(Zs,{card:E.value.card,hidden:E.value.hidden},null,8,[`card`,`hidden`])])],4)):Q(``,!0)]))}}));ll.use(ys()),ll.mount(`#app`);";
const RELEASE_CSS = "/*! tailwindcss v4.1.18 | MIT License | https://tailwindcss.com */\n@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inline))) or ((-moz-orient:inline) and (not (color:rgb(from red r g b)))){*,:before,:after,::backdrop{--tw-rotate-x:initial;--tw-rotate-y:initial;--tw-rotate-z:initial;--tw-skew-x:initial;--tw-skew-y:initial;--tw-blur:initial;--tw-brightness:initial;--tw-contrast:initial;--tw-grayscale:initial;--tw-hue-rotate:initial;--tw-invert:initial;--tw-opacity:initial;--tw-saturate:initial;--tw-sepia:initial;--tw-drop-shadow:initial;--tw-drop-shadow-color:initial;--tw-drop-shadow-alpha:100%;--tw-drop-shadow-size:initial}}}@layer theme{:root,:host{--font-sans:ui-sans-serif,system-ui,sans-serif,\"Apple Color Emoji\",\"Segoe UI Emoji\",\"Segoe UI Symbol\",\"Noto Color Emoji\";--font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,\"Liberation Mono\",\"Courier New\",monospace;--default-font-family:var(--font-sans);--default-mono-font-family:var(--font-mono)}}@layer base{*,:after,:before,::backdrop{box-sizing:border-box;border:0 solid;margin:0;padding:0}::file-selector-button{box-sizing:border-box;border:0 solid;margin:0;padding:0}html,:host{-webkit-text-size-adjust:100%;tab-size:4;line-height:1.5;font-family:var(--default-font-family,ui-sans-serif,system-ui,sans-serif,\"Apple Color Emoji\",\"Segoe UI Emoji\",\"Segoe UI Symbol\",\"Noto Color Emoji\");font-feature-settings:var(--default-font-feature-settings,normal);font-variation-settings:var(--default-font-variation-settings,normal);-webkit-tap-highlight-color:transparent}hr{height:0;color:inherit;border-top-width:1px}abbr:where([title]){-webkit-text-decoration:underline dotted;text-decoration:underline dotted}h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}a{color:inherit;-webkit-text-decoration:inherit;-webkit-text-decoration:inherit;-webkit-text-decoration:inherit;-webkit-text-decoration:inherit;text-decoration:inherit}b,strong{font-weight:bolder}code,kbd,samp,pre{font-family:var(--default-mono-font-family,ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,\"Liberation Mono\",\"Courier New\",monospace);font-feature-settings:var(--default-mono-font-feature-settings,normal);font-variation-settings:var(--default-mono-font-variation-settings,normal);font-size:1em}small{font-size:80%}sub,sup{vertical-align:baseline;font-size:75%;line-height:0;position:relative}sub{bottom:-.25em}sup{top:-.5em}table{text-indent:0;border-color:inherit;border-collapse:collapse}:-moz-focusring{outline:auto}progress{vertical-align:baseline}summary{display:list-item}ol,ul,menu{list-style:none}img,svg,video,canvas,audio,iframe,embed,object{vertical-align:middle;display:block}img,video{max-width:100%;height:auto}button,input,select,optgroup,textarea{font:inherit;font-feature-settings:inherit;font-variation-settings:inherit;letter-spacing:inherit;color:inherit;opacity:1;background-color:#0000;border-radius:0}::file-selector-button{font:inherit;font-feature-settings:inherit;font-variation-settings:inherit;letter-spacing:inherit;color:inherit;opacity:1;background-color:#0000;border-radius:0}:where(select:is([multiple],[size])) optgroup{font-weight:bolder}:where(select:is([multiple],[size])) optgroup option{padding-inline-start:20px}::file-selector-button{margin-inline-end:4px}::placeholder{opacity:1}@supports (not ((-webkit-appearance:-apple-pay-button))) or (contain-intrinsic-size:1px){::placeholder{color:currentColor}@supports (color:color-mix(in lab, red, red)){::placeholder{color:color-mix(in oklab,currentcolor 50%,transparent)}}}textarea{resize:vertical}::-webkit-search-decoration{-webkit-appearance:none}::-webkit-date-and-time-value{min-height:1lh;text-align:inherit}::-webkit-datetime-edit{display:inline-flex}::-webkit-datetime-edit-fields-wrapper{padding:0}::-webkit-datetime-edit{padding-block:0}::-webkit-datetime-edit-year-field{padding-block:0}::-webkit-datetime-edit-month-field{padding-block:0}::-webkit-datetime-edit-day-field{padding-block:0}::-webkit-datetime-edit-hour-field{padding-block:0}::-webkit-datetime-edit-minute-field{padding-block:0}::-webkit-datetime-edit-second-field{padding-block:0}::-webkit-datetime-edit-millisecond-field{padding-block:0}::-webkit-datetime-edit-meridiem-field{padding-block:0}::-webkit-calendar-picker-indicator{line-height:1}:-moz-ui-invalid{box-shadow:none}button,input:where([type=button],[type=reset],[type=submit]){appearance:button}::file-selector-button{appearance:button}::-webkit-inner-spin-button{height:auto}::-webkit-outer-spin-button{height:auto}[hidden]:where(:not([hidden=until-found])){display:none!important}}@layer components;@layer utilities{.visible{visibility:visible}.hidden{display:none}.table{display:table}.transform{transform:var(--tw-rotate-x,)var(--tw-rotate-y,)var(--tw-rotate-z,)var(--tw-skew-x,)var(--tw-skew-y,)}.resize{resize:both}.filter{filter:var(--tw-blur,)var(--tw-brightness,)var(--tw-contrast,)var(--tw-grayscale,)var(--tw-hue-rotate,)var(--tw-invert,)var(--tw-saturate,)var(--tw-sepia,)var(--tw-drop-shadow,)}}:root{--lightningcss-light: ;--lightningcss-dark:initial;color-scheme:dark;--gold:#dbb982;--cream:#f7ebd3;--felt:#154438;--ink:#0b1916;--tg-safe-top:0px;--tg-safe-bottom:0px;--tg-safe-left:0px;--tg-safe-right:0px;--app-vh:100dvh;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}*,:before,:after{box-sizing:border-box}html,body,#app{width:100%;height:100%;margin:0;overflow:hidden}body{color:var(--cream);overscroll-behavior:none;background:#12140e}button,input{font:inherit}button{-webkit-tap-highlight-color:transparent;cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid var(--gold);outline-offset:3px}img{-webkit-user-drag:none;-webkit-user-select:none;user-select:none;pointer-events:none}.app-shell{width:100%;height:var(--app-vh);height:min(var(--app-vh),100dvh);padding:max(8px,env(safe-area-inset-top),var(--tg-safe-top))max(8px,env(safe-area-inset-right),var(--tg-safe-right))max(8px,env(safe-area-inset-bottom),var(--tg-safe-bottom))max(8px,env(safe-area-inset-left),var(--tg-safe-left));isolation:isolate;background:radial-gradient(at 48% 43%,#195140bf,#0d2b25fa 76%),repeating-linear-gradient(92deg,#263123 0 8px,#1b271e 8px 17px,#242b21 17px 25px);flex-direction:column;display:flex;position:relative;overflow:hidden}.app-shell:before{content:\"\";pointer-events:none;z-index:-1;background:repeating-linear-gradient(0deg,#0000 0 2px,#ffffff04 2px 3px),radial-gradient(#0000 32%,#0000007d 100%);position:absolute;inset:0}.game-bar{z-index:40;justify-content:space-between;align-items:center;gap:8px;min-height:35px;padding:0 clamp(2px,1.7vw,16px);display:flex}.brand{letter-spacing:-.045em;color:var(--cream);white-space:nowrap;font-size:clamp(13px,3.8vw,19px);font-weight:900}.brand strong{color:var(--gold)}.game-bar__meta{color:#f1e7caa8;letter-spacing:.1em;font-size:10px}.game-bar__actions{align-items:center;gap:6px;display:flex}.icon-button{min-width:33px;min-height:33px;color:var(--cream);background:0 0;border:none;border-radius:100px;padding:5px 8px;transition:transform .18s,background .18s}.icon-button:active{background:#ffffff12;transform:scale(.93)}.stars-placeholder{white-space:nowrap;color:var(--gold);letter-spacing:.02em;align-items:center;gap:5px;font-size:12px;font-weight:800;display:inline-flex}.stars-placeholder small{color:#e3dfc9a3;font-size:9px;font-weight:500}.game-viewport{flex-direction:column;flex:1;min-height:0;display:flex;position:relative}.table{flex:1;min-width:0;min-height:0;position:relative}.table:after{content:\"\";pointer-events:none;border:1px solid #dbb9820e;border-radius:50%;position:absolute;inset:6% 10% 17%;transform:scaleX(1.15)}.table__seat{z-index:6;justify-content:center;display:flex;position:absolute}.table__seat--top-left{top:4%;left:14%}.table__seat--top-center{top:1%;left:50%;transform:translate(-50%)}.table__seat--top-right{top:4%;right:14%}.table__seat--left{top:37%;left:3%}.table__seat--right{top:37%;right:3%}.table__deck{z-index:8;color:var(--cream);touch-action:none;-webkit-user-select:none;user-select:none;background:0 0;border:0;flex-direction:column;align-items:center;padding:0;display:flex;position:absolute;top:51%;left:50%;transform:translate(-50%,-50%)}.table__deck:disabled{cursor:default}.table__deck:before{content:\"\";background:#010a07;border-radius:8px;position:absolute;inset:5px 2px -3px;transform:rotate(-4deg);box-shadow:0 11px 22px #0006}.table__deck-count{color:#e9d8b4bd;margin-top:7px;font-size:10px;line-height:1}.table__deck--turn{filter:drop-shadow(0 0 11px #d9b36d59)}.table__deck--turn:active{transform:translate(-50%,-50%)scale(.96)}.table__trump{z-index:9;color:#eed5a8;white-space:nowrap;font-size:11px;position:absolute;top:51%;left:calc(50% + 47px);transform:translateY(-50%)}.table__trump b{vertical-align:middle;font-size:19px}.table__trump--red b{color:#ef8d7d}.table__trick{z-index:13;pointer-events:none;min-width:40px;min-height:58px;display:flex;position:absolute;top:63%;left:50%;transform:translate(-50%,-50%)}.table__trick .playing-card{transform:rotate(var(--trick-rot,0deg))translate(var(--trick-x,0px),var(--trick-y,0px));position:absolute;top:0;left:0}.table__play-target{z-index:5;pointer-events:auto;background:0 0;border:none;border-radius:44%;transition:box-shadow .15s,background-color .15s;position:absolute;inset:20% 21% 13%}.table__play-target--enabled{background:radial-gradient(#d3a96107,#0000 70%)}:is(.table__play-target--dragover,.table__play-target--enabled:has(~.hand-fan__ghost--over)){background:#d4bd8240;box-shadow:inset 0 0 0 1px #dab77167}.table__active{z-index:19;touch-action:none;cursor:grab;position:absolute;top:55%;left:50%;transform:translate(-50%,-50%)}.table__active:active{cursor:grabbing}.table__active--drag{left:var(--drag-x);top:var(--drag-y);z-index:90;position:fixed;transform:translate(-50%,-50%)}.table__active .playing-card{box-shadow:0 16px 30px #0009}.table__target-hint{color:#dac99e9a;white-space:nowrap;pointer-events:none;font-size:11px;position:absolute;bottom:8%;left:50%;transform:translate(-50%)}.table__discard{z-index:3;opacity:.25;pointer-events:none;position:absolute;top:52%;left:71%;transform:rotate(9deg)}.table__discard-num{text-align:center;color:#f6dca2;width:100%;font-size:9px;position:absolute;top:100%}.seat{cursor:pointer;background:0 0;border:none;border-radius:0;flex-direction:column;align-items:center;gap:3px;min-width:64px;max-width:108px;padding:0;display:flex;position:relative}.seat__identity{text-shadow:0 1px 4px #000;justify-content:center;align-items:center;gap:3px;max-width:102px;font-size:clamp(10px,2.7vw,12px);font-weight:700;display:flex}.seat__name{white-space:nowrap;text-overflow:ellipsis;max-width:68px;overflow:hidden}.seat--active .seat__name{color:var(--gold);text-shadow:0 0 10px #f5bd647e}.seat__turn{color:var(--gold);text-shadow:0 0 9px #e1a94b;font-size:8px;animation:1.6s ease-in-out infinite tiny-pulse}.seat__penalties{white-space:nowrap;color:#f49f93;font-size:10px}.seat__cards{justify-content:center;align-items:center;width:48px;height:66px;display:flex;position:relative}.seat__pile-card{transition:transform .27s cubic-bezier(.17,.8,.25,1);position:absolute;inset:0}.seat__closed-hand{position:absolute;transform:translate(10px,2px)rotate(8deg)}.seat__count,.seat__status{color:#f5e7cf93;font-size:9px;line-height:1.1}.seat__status{color:#aec8a4}.seat--exited{opacity:.55}.table__seat--self{bottom:1%;left:50%;transform:translate(-50%)}.table__seat--target .seat__name{color:var(--gold);text-shadow:0 0 12px #eed1a8}.table__active-anchor{pointer-events:none;width:84px;height:118px;position:absolute;top:55%;left:50%;transform:translate(-50%,-50%)}.playing-card{backface-visibility:hidden;transform-origin:50% 84%;background:#f5edda;border:1px solid #ece2ca;border-radius:6px;flex:none;width:84px;height:118px;position:relative;overflow:hidden;box-shadow:0 5px 12px #0008,inset 0 0 0 1px #fff4}.playing-card img{-o-object-fit:fill;object-fit:fill;width:100%;height:100%;display:block}.playing-card--small{border-radius:4px;width:47px;height:67px}.playing-card--back{background:#242929;border-color:#c8a875}.playing-card__fallback-back{width:100%;height:100%;color:var(--gold);background:repeating-linear-gradient(45deg,#193d3a 0 5px,#21433d 5px 8px);border:4px double #d3a467;place-items:center;font-size:27px;display:grid}.playing-card__fallback-front{color:#222;flex-direction:column;justify-content:space-around;align-items:center;height:100%;display:flex}.playing-card__fallback-front strong{font-size:45px;line-height:1}.playing-card__fallback-front b{font-size:12px}.playing-card--red .playing-card__fallback-front{color:#a53834}.playing-card--small .playing-card__fallback-front strong{font-size:23px}.hand-area{z-index:30;flex-direction:column;flex:none;justify-content:flex-end;align-items:center;width:100%;min-height:122px;display:flex;position:relative}.hand-area__label{text-align:center;color:#e5ce9b;min-height:13px;font-size:10px;font-weight:600}.hand-area__actions{z-index:70;justify-content:center;gap:7px;min-height:30px;display:flex}.action-pill{color:#142621;background:#e3c18a;border:0;border-radius:99px;padding:7px 14px;font-size:11px;font-weight:800;box-shadow:0 2px 8px #0004}.action-pill--quiet{color:#e8d0a7;background:#d3c4a61f}.hand-fan{touch-action:none;-webkit-user-select:none;user-select:none;cursor:pointer;width:100%;height:132px;position:relative}.hand-fan__cards{height:116px;position:absolute;top:17px;left:50%;transform:translate(-50%)}.hand-fan__slot{width:84px;height:118px;transform:translateX(var(--fan-x))rotate(var(--fan-angle));transform-origin:50% 120%;filter:drop-shadow(0 3px 5px #0004);margin-left:-42px;transition:transform .18s cubic-bezier(.22,.75,.18,1),opacity .15s;position:absolute;top:0;left:50%}.hand-fan__slot--active{transform:translateX(var(--fan-x))rotate(0deg)translateY(-23px)scale(1.07);filter:drop-shadow(0 10px 10px #0008)}.hand-fan__slot--dragging{opacity:0!important}.hand-fan__ghost{z-index:999;pointer-events:none;filter:drop-shadow(0 18px 20px #0009);width:84px;height:118px;position:fixed;transform:translate(-50%,-50%)rotate(0)scale(1.05)}.hand-fan__ghost--over{filter:drop-shadow(0 0 10px #e3c18a94)drop-shadow(0 12px 12px #000a)}.hand-fan__ghost--snap{transition:left .22s cubic-bezier(.2,.9,.3,1.12),top .22s cubic-bezier(.2,.9,.3,1.12),transform .22s;transform:translate(-50%,-50%)scale(.96)}.hand-fan--disabled{opacity:.65;touch-action:none}.card-flight{z-index:85;pointer-events:none;will-change:transform;transform-origin:50%;width:84px;height:118px;position:fixed;top:0;left:0}.card-flight__body{width:100%;height:100%;transform-style:preserve-3d}.toast{z-index:100;color:var(--cream);text-align:center;pointer-events:none;background:#122f29ed;border:1px solid #dab97845;border-radius:25px;max-width:86%;padding:7px 15px;font-size:12px;position:absolute;top:8px;left:50%;transform:translate(-50%);box-shadow:0 7px 22px #0004}.toast-enter-active,.toast-leave-active{transition:opacity .2s,transform .2s}.toast-enter-from,.toast-leave-to{opacity:0;transform:translate(-50%,-12px)}.lobby{flex:1;place-items:center;min-height:0;padding:4vw;display:grid}.lobby__panel{background:#142e27b8;border:1px solid #c29b5e36;border-radius:18px;flex-direction:column;gap:14px;width:min(400px,100%);padding:22px;display:flex;box-shadow:0 12px 34px #0004}.lobby__title{text-align:center;color:var(--gold);letter-spacing:-.075em;font-size:clamp(30px,7vw,46px);font-weight:900}.lobby__subtitle{text-align:center;color:#e9dac5aa;font-size:12px}.lobby__field{color:var(--cream);background:#061c18;border:1px solid #beae7852;border-radius:9px;outline:none;min-height:43px;padding:0 12px;font-size:14px}.lobby__button{background:var(--gold);color:#132d26;border:0;border-radius:10px;min-height:47px;font-weight:800}.lobby__people{flex-wrap:wrap;justify-content:center;gap:8px;display:flex}.lobby__person{color:#f2dfb7;font-size:12px}.lobby__secondary{min-height:37px;color:var(--cream);background:#a3a07c24;border:0;border-radius:8px}@keyframes tiny-pulse{0%,to{opacity:.65}50%{opacity:1}}@media (width<=430px){.table__seat--top-left{top:4%;left:12%}.table__seat--top-right{top:4%;right:12%}.table__seat--left{top:35%;left:1%}.table__seat--right{top:35%;right:1%}.table__trump{left:calc(50% + 38px)}.game-bar{min-height:33px}.playing-card{width:76px;height:107px}.playing-card--small{width:42px;height:60px}.seat__cards{width:44px;height:60px}.hand-area{min-height:113px}.hand-fan{height:119px}.hand-fan__cards{top:12px}.hand-fan__slot{width:76px;height:107px;margin-left:-38px}.hand-fan__ghost{width:76px;height:107px}}@media (height<=635px){.table__seat--top-left,.table__seat--top-right{top:1%}.table__seat--top-center{top:0}.table__seat--left,.table__seat--right{top:30%}.table__deck{top:50%}.table__trick{top:64%}.seat__cards{transform-origin:top;margin-bottom:-8px;transform:scale(.85)}.hand-area{min-height:103px}.hand-fan{height:109px}}@media (orientation:landscape) and (height<=500px){.game-bar{min-height:29px}.hand-area{width:65%;height:103px;min-height:103px;position:absolute;bottom:0;left:50%;transform:translate(-50%)}.hand-area__label{display:none}.table__seat--top-left{left:24%}.table__seat--top-right{right:24%}.table__seat--left{top:37%;left:5%}.table__seat--right{top:37%;right:5%}.table__deck{top:40%;left:50%}.table__trump{top:40%}.table__trick{top:52%}}@media (prefers-reduced-motion:reduce){*,:before,:after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important}}.lobby__tabs{grid-template-columns:repeat(4,1fr);gap:3px;display:grid}.lobby__tabs button{color:#d6c29cbf;background:0 0;border:none;border-bottom:1px solid #d5b57629;padding:10px 2px;font-size:11px}.lobby__tabs button.active{color:var(--gold);border-color:var(--gold)}.lobby__stack{scrollbar-width:thin;flex-direction:column;gap:9px;min-height:68px;max-height:32dvh;display:flex;overflow-y:auto}.lobby__room{text-align:left;color:#f6e5c5;background:#06271f83;border:1px solid #bb996b31;border-radius:9px;flex-direction:column;gap:3px;padding:8px 12px;font-size:12px;display:flex}.lobby__room small{color:#dccaa39c;font-size:10px}.lobby__checkbox{color:#ecd6aa;align-items:center;gap:8px;font-size:12px;display:flex}.lobby__checkbox input{accent-color:#dfbd7d;width:16px;height:16px}.lobby input[type=range]{accent-color:#dfbd7d;width:100%}.hand-area__actions .action-pill:disabled{opacity:.35;cursor:default}.hand-area__actions{flex-wrap:wrap;max-width:100%}@media (width<=380px){.lobby__panel{gap:9px;padding:15px}.hand-area__actions .action-pill{padding:5px 8px;font-size:10px}}.end-screen{inset:10% max(12px,env(safe-area-inset-right))5%;z-index:100;text-align:center;background:radial-gradient(at 50% 26%,#1d5145 0%,#0c2822f8 77%);border-radius:20px;flex-direction:column;justify-content:center;align-items:center;gap:clamp(8px,2vh,14px);padding:clamp(12px,4vw,24px);animation:.5s cubic-bezier(.19,.75,.21,1) both end-enter;display:flex;position:absolute;box-shadow:0 24px 80px #0009}.end-screen h2{color:#f3ddb5;letter-spacing:-.05em;margin:0;font-size:clamp(25px,7vw,36px);font-weight:900}.end-screen p{color:var(--cream);margin:0;font-size:13px}.end-screen__eyebrow{letter-spacing:.16em;text-transform:uppercase;color:var(--gold);font-size:10px}.end-screen__scores{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 15px;width:min(330px,100%);display:grid}.end-screen__scores span{text-align:left;text-overflow:ellipsis;justify-content:space-between;gap:7px;font-size:12px;display:flex;overflow:hidden}.end-screen__scores b{color:#e8ac94}.end-screen .lobby__button{padding:0 24px}@keyframes end-enter{0%{opacity:0;transform:translateY(16px)scale(.97)}to{opacity:1;transform:none}}@media (orientation:landscape) and (height<=500px){.hand-area{pointer-events:none;height:46px;min-height:46px}.hand-area__actions{pointer-events:auto}.hand-area--fan{pointer-events:auto;height:103px;min-height:103px}.table__seat--self{bottom:53px}}.profile__metrics{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0 20px;display:grid}.profile__metrics span{text-align:center;background:#ffffff0b;border-radius:10px;flex-direction:column;gap:6px;padding:10px 5px;font-size:11px;display:flex}.profile__metrics b{color:#f1dba0;font-size:23px}.profile__heading{margin:8px 0;font-size:15px;font-weight:600}.profile__history{flex-direction:column;gap:5px;max-height:32vh;display:flex;overflow-y:auto}.profile__match{background:#ffffff09;border-radius:9px;flex-direction:column;gap:4px;padding:10px 12px;font-size:13px;display:flex}.profile__match small{opacity:.65;font-size:11px}.app-shell{padding-left:max(16px,env(safe-area-inset-left),var(--tg-safe-left));padding-right:max(16px,env(safe-area-inset-right),var(--tg-safe-right))}.table__seat--left{left:5%}.table__seat--right{right:5%}.table__seat--top-left{left:17%}.table__seat--top-right{right:17%}.table__seat--top-center{top:4%}.hand-fan__slot .playing-card{border:0;outline:0;overflow:hidden;box-shadow:0 7px 14px #0007}.hand-fan__slot--active .playing-card{box-shadow:0 13px 24px #0009,0 0 15px #e7c58d32}.hand-fan__slot{filter:none}.table-vfx{z-index:98;pointer-events:none;filter:drop-shadow(0 0 5px #eac47c);width:0;height:0;animation:.45s ease-out both vfx-flash;position:fixed}.table-vfx i{width:3px;height:11px;transform:rotate(var(--spark-angle))translateY(-9px);transform-origin:50% 24px;background:#f9d69b;border-radius:3px;animation:.55s cubic-bezier(.1,.6,.2,1) both vfx-spark;position:absolute;top:0;left:0}.table-vfx--penalty i{background:#ff877a}.table-vfx--play i{background:#d5f5c5}@keyframes vfx-spark{0%{opacity:1;transform:rotate(var(--spark-angle))translateY(-7px)scale(1.2)}to{opacity:0;transform:rotate(var(--spark-angle))translateY(-46px)scale(.15)}}@keyframes vfx-flash{0%{opacity:0}20%{opacity:1}to{opacity:0}}@media (width<=430px){.table__seat--left{left:5%}.table__seat--right{right:5%}.table__seat--top-left{left:18%}.table__seat--top-right{right:18%}.table__seat--top-center{top:4%}.seat__name{max-width:58px}.game-bar{gap:3px}.game-bar__actions{gap:1px}.icon-button{min-width:29px;padding:4px}.brand{font-size:14px}.game-bar__meta{text-overflow:ellipsis;white-space:nowrap;max-width:112px;overflow:hidden}}@media (prefers-reduced-motion:reduce){.table-vfx,.table-vfx i{animation:none;display:none}}.table__active--dealing:not(.table__active--drag){z-index:22;animation:.24s cubic-bezier(.18,.8,.22,1) both dealt-card-arrive;top:72%}.table__active-anchor{top:72%}.table__active--dealing .playing-card{box-shadow:0 14px 26px #0009}.table__deck{top:48%}@keyframes dealt-card-arrive{0%{opacity:.65;transform:translate(-50%,-58%)scale(.94)}to{opacity:1;transform:translate(-50%,-50%)scale(1)}}@media (height<=650px){.table__active--dealing:not(.table__active--drag),.table__active-anchor{top:69%}}@media (prefers-reduced-motion:reduce){.table__active--dealing:not(.table__active--drag){animation:none}}.table__deck:before{box-shadow:none;background:0 0;transform:none}.table__deck .playing-card{filter:drop-shadow(0 7px 12px #0005)}.table__active--dealing{cursor:grab;touch-action:none}.table__active--dealing:not(.table__active--drag) .playing-card{filter:drop-shadow(0 0 9px #e7c68277)drop-shadow(0 11px 12px #0007);transition:filter .18s,transform .18s}.table__active--dealing:not(.table__active--drag):active .playing-card{filter:drop-shadow(0 0 16px #f4d49bbb)drop-shadow(0 17px 15px #0009)}.table__active--drag .playing-card{filter:drop-shadow(0 0 17px #f2d08fa8)drop-shadow(0 15px 15px #0008)}.table__seat--target .seat__cards{filter:drop-shadow(0 0 14px #f6d18ba0)}.table-vfx i{animation-duration:.49s}@media (prefers-reduced-motion:reduce){.table__active--dealing .playing-card{transition:none}}@property --tw-rotate-x{syntax:\"*\";inherits:false}@property --tw-rotate-y{syntax:\"*\";inherits:false}@property --tw-rotate-z{syntax:\"*\";inherits:false}@property --tw-skew-x{syntax:\"*\";inherits:false}@property --tw-skew-y{syntax:\"*\";inherits:false}@property --tw-blur{syntax:\"*\";inherits:false}@property --tw-brightness{syntax:\"*\";inherits:false}@property --tw-contrast{syntax:\"*\";inherits:false}@property --tw-grayscale{syntax:\"*\";inherits:false}@property --tw-hue-rotate{syntax:\"*\";inherits:false}@property --tw-invert{syntax:\"*\";inherits:false}@property --tw-opacity{syntax:\"*\";inherits:false}@property --tw-saturate{syntax:\"*\";inherits:false}@property --tw-sepia{syntax:\"*\";inherits:false}@property --tw-drop-shadow{syntax:\"*\";inherits:false}@property --tw-drop-shadow-color{syntax:\"*\";inherits:false}@property --tw-drop-shadow-alpha{syntax:\"<percentage>\";inherits:false;initial-value:100%}@property --tw-drop-shadow-size{syntax:\"*\";inherits:false}\n";
var cloudflare_worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Single canonical Mini App entry point: legacy / must never show the old UI.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      // Render the same Mini App directly. Redirects can keep an older
      // Telegram WebView document alive while navigating between screens.
      return new Response(RELEASE_HTML, {headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, max-age=0, must-revalidate",
        "x-pidor-ui": "telegram-mini-app"
      }});
    }
    if (url.pathname === "/api/app" || url.pathname === "/api/app/") return new Response(RELEASE_HTML,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-pidor-release":"p3-p4"}});
    if (url.pathname === "/api/app.js") return new Response(RELEASE_JS,{headers:{"content-type":"application/javascript; charset=utf-8","cache-control":"no-store"}});
    if (url.pathname === "/api/app.css") return new Response(RELEASE_CSS,{headers:{"content-type":"text/css; charset=utf-8","cache-control":"no-store"}});
    if (url.pathname === "/api/app/meta") return Response.json({release:"P3-P4",ui:"telegram",backend:"v94",deployed:"2026-11-12"});
    if (url.pathname.startsWith("/telegram/")) return handleTelegram(request, env);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "pidor" });
    if (url.pathname === "/api/rooms") {
      const directory = env.LOBBY.getByName("public-tables");
      if (request.method === "GET") return directory.fetch("https://lobby.internal/list");
      if (request.method === "POST") {
        if (Number(request.headers.get("content-length") || 0) > 1024) return new Response("Payload too large", { status: 413 });
        const body = await request.text();
        if (body.length > 1024) return new Response("Payload too large", { status: 413 });
        return directory.fetch("https://lobby.internal/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body
        });
      }
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/api/room" && request.method === "GET") {
      const id = url.searchParams.get("id") || "";
      if (!/^[A-Za-z0-9_-]{1,48}$/.test(id)) return new Response("Bad id", { status: 400 });
      return env.LOBBY.getByName("public-tables").fetch("https://lobby.internal/get?id=" + encodeURIComponent(id));
    }
    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room") || "";
      if (!/^[A-Za-z0-9_-]{1,48}$/.test(room)) return new Response("Invalid room", { status: 400 });
      return env.ROOMS.getByName("room:" + room).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  LobbyDirectory,
  PidorRoom,
  cloudflare_worker_default as default
};
//# sourceMappingURL=cloudflare-worker.js.map
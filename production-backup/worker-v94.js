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
  return origin + (mode === "bot" ? "/?mode=bot" : "/?mode=friends");
}
__name(miniAppLink, "miniAppLink");
async function replyToMessage(env, update, origin) {
  const message = update.message;
  if (!message?.chat || message.chat.type !== "private") return;
  const raw = (message.text || "").trim();
  const command = raw.split(/\s+/)[0].split("@")[0].toLowerCase();
  if (!["/start", "/play", "/game", "/help"].includes(command)) return;
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
      menu_button: { type: "web_app", text: "\u{1F3AE} \u0418\u0433\u0440\u0430\u0442\u044C", web_app: { url: origin } }
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
var cloudflare_worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
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
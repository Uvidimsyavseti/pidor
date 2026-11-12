import type { Card, Suit, Rank, GameState } from '../shared/types.js';
import { INITIAL_DEAL_LEAD_MS, initialDealDuration, initialCardCount } from '../shared/initialDeal.ts';

export const RANKS: Rank[] = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUITS: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];

export const VIOLATION_WINDOW_MS = 15_000;
export interface RuleViolation { id: string; playerId: string; reason: string; createdAt: number; cardId?: string; }
export interface AccusationVerdict { correct: boolean; accusedId: string; penalizedId: string; reason: string; }

export const RANK_VALUE: Record<Rank, number> = {
  '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: `${rank}_of_${suit}` });
    }
  }
  return shuffle(deck);
}

function shuffle<T>(array: T[]): T[] {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

export class PidorGame {
  state: GameState;
  private penaltyDebts: Record<string, Record<string, number>> = {};
  private penaltyQueue: { giverId: string; receiverId: string }[] = [];
  private previousDeckSuit: Suit | null = null;
  private lockedDrawCards: string[] = [];
  private violations: RuleViolation[] = [];
  private lastAccusationAt: Record<string, number> = {};
  reviewDeadlineAt = 0;
  onPenalty: ((playerId: string, reason: string) => void) | null = null;

  snapshot() { return { state: this.state, penaltyDebts: this.penaltyDebts, penaltyQueue: this.penaltyQueue, previousDeckSuit: this.previousDeckSuit, lockedDrawCards: this.lockedDrawCards, violations: this.violations, lastAccusationAt: this.lastAccusationAt, reviewDeadlineAt: this.reviewDeadlineAt }; }
  restore(saved: { state: GameState; penaltyDebts?: Record<string, Record<string, number>>; penaltyQueue?: { giverId: string; receiverId: string }[]; previousDeckSuit?: Suit | null; lockedDrawCards?: string[]; violations?: RuleViolation[]; lastAccusationAt?: Record<string, number>; reviewDeadlineAt?: number }) {
    this.state = saved.state;
    this.penaltyDebts = saved.penaltyDebts || {};
    this.penaltyQueue = saved.penaltyQueue || this.buildPenaltyQueue();
    this.previousDeckSuit = saved.previousDeckSuit || null;
    this.lockedDrawCards = saved.lockedDrawCards || [];
    this.violations = saved.violations || [];
    this.lastAccusationAt = saved.lastAccusationAt || {};
    this.reviewDeadlineAt = saved.reviewDeadlineAt || 0;
  }

  constructor(playerIds: { id: string, name: string }[]) {
    this.state = {
      phase: 'LOBBY',
      players: playerIds.map(p => ({
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

  start(underlaidCards: boolean = this.state.underlaidCards !== false) {
    this.state.underlaidCards = underlaidCards;
    this.violations = [];
    this.lastAccusationAt = {};
    this.reviewDeadlineAt = 0;
    this.state.deck = createDeck();
    this.state.lastDrawEvent = undefined;
    this.lockedDrawCards = [];
    // Deal clockwise: one card per player per round. The LAST round is
    // visible; preceding rounds (only in underlaid mode) stay face-down.
    for (const player of this.state.players) {
      player.stumps = [];
      player.hand = [];
    }
    for (let round = 0; round < initialCardCount(underlaidCards); round++) {
      for (const player of this.state.players) player.stumps.push(this.state.deck.pop()!);
    }
    this.state.initialDealAt = Date.now() + INITIAL_DEAL_LEAD_MS;
    this.state.initialDealEndsAt = this.state.initialDealAt +
      initialDealDuration(this.state.players.length, underlaidCards);
    this.state.trumpSuit = null;
    this.previousDeckSuit = null;
    this.state.phase = 'DEALING'; 
    this.state.turnIndex = 0;
    console.log("[GAME] Started. First turn:", this.state.players[0].name);
  }

  canBeat(card: Card, target: Card | undefined): boolean {
    if (!target) return false;
    // During dealing suits do not matter: next rank only.
    // Six wraps onto ace, except the spade six.
    if (card.rank === '6') return card.suit !== 'spades' && target.rank === 'A';
    return RANK_VALUE[card.rank] === RANK_VALUE[target.rank] + 1;
  }

  canMoveTopCard(playerId: string): boolean {
    const p = this.state.players.find(p => p.id === playerId);
    const top = p?.stumps.at(-1);
    return this.state.phase === 'DEALING' && !!top &&
      p!.stumps.length > (this.state.underlaidCards === false ? 1 : 3) && !this.lockedDrawCards.includes(top.id);
  }

  private getPlayerIdx(id: string) { return this.state.players.findIndex(p => p.id === id); }

  /**
   * Record an observable violation; never award a penalty automatically.
   * Another player must explicitly accuse the offender for it to count.
   */
  addPenalty(idx: number, reason: string, cardId?: string): void {
    if (idx < 0 || this.state.phase === 'LOBBY' || this.state.phase === 'ENDED') return;
    const offenderId = this.state.players[idx]?.id;
    if (!offenderId) return;
    const now = Date.now();
    this.violations = this.violations.filter(v => now - v.createdAt < VIOLATION_WINDOW_MS);
    // Unnoticed violations expire after 15 seconds: no retroactive fines.
    // Repeated requests for the same invalid action do not stack accusations.
    if (this.violations.some(v => v.playerId === offenderId && v.reason === reason && v.cardId === cardId && now - v.createdAt < 2500)) return;
    this.violations.push({ id: crypto.randomUUID(), playerId: offenderId, reason, createdAt: now, cardId });
    if (this.violations.length > 80) this.violations.shift();
  }

  accusableTargets(observerId: string): string[] {
    const now = Date.now();
    if (!this.state.players.some(p => p.id === observerId)) return [];
    return [...new Set(this.violations.filter(v => v.playerId !== observerId && now - v.createdAt < VIOLATION_WINDOW_MS).map(v => v.playerId))];
  }

  canAccuseNow(playerId: string): boolean {
    return Date.now() - (this.lastAccusationAt[playerId] || 0) >= 1500;
  }

  /**
   * A caught opportunistic draw is moved to the offender's pile even if
   * they already laid it on an opponent. If no one accuses within 15s,
   * its placement stands. The card is never copied or destroyed.
   */
  private reclaimCaughtCard(offenderId: string, cardId: string): void {
    const offender = this.state.players.find(p => p.id === offenderId);
    if (!offender || offender.stumps.some(c => c.id === cardId)) return;

    let seized: Card | undefined;
    if (this.state.activeCard?.card.id === cardId) {
      seized = this.state.activeCard.card;
      this.state.activeCard = null;
    } else {
      for (const player of this.state.players) {
        for (const pile of [player.stumps, player.hand]) {
          const index = pile.findIndex(c => c.id === cardId);
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

  accuse(accuserId: string, accusedId: string): AccusationVerdict | null {
    if (this.state.phase === 'LOBBY' || this.state.phase === 'ENDED') return null;
    const accuser = this.state.players.find(p => p.id === accuserId && !p.hasExited);
    const accused = this.state.players.find(p => p.id === accusedId);
    if (!accuser || !accused || accuserId === accusedId) return null;
    const now = Date.now();
    if (now - (this.lastAccusationAt[accuserId] || 0) < 1500) return null;
    this.lastAccusationAt[accuserId] = now;
    this.violations = this.violations.filter(v => now - v.createdAt < VIOLATION_WINDOW_MS);
    const index = this.violations.findIndex(v => v.playerId === accusedId);
    const correct = index !== -1;
    const confirmedViolation = correct ? this.violations.splice(index, 1)[0] : null;
    const reason = confirmedViolation?.reason || 'Ложное обвинение';
    if (confirmedViolation?.cardId) this.reclaimCaughtCard(accusedId, confirmedViolation.cardId);
    const punished = correct ? accused : accuser;
    punished.penalties++;
    this.onPenalty?.(punished.id, reason);
    return { correct, accusedId, penalizedId: punished.id, reason };
  }

  expireReview(): boolean {
    if (this.state.phase !== 'PENALTY_REVIEW' || !this.reviewDeadlineAt || Date.now() < this.reviewDeadlineAt) return false;
    this.violations = [];
    this.transitionToPenaltyDistribution();
    return true;
  }

  finishReview(playerId: string): boolean {
    if (this.state.phase !== 'PENALTY_REVIEW') return false;
    const player = this.state.players.find(p => p.id === playerId);
    if (!player) return false;
    player.isReady = true;
    if (this.state.players.every(p => p.isReady || p.isBot)) {
      this.violations = []; // No retroactive accusations after distributing cards.
      this.transitionToPenaltyDistribution();
    }
    return true;
  }

  private enterReview(): void {
    this.state.phase = 'PENALTY_REVIEW';
    this.reviewDeadlineAt = Date.now() + VIOLATION_WINDOW_MS;
    for (const player of this.state.players) player.isReady = !!player.isBot;
  }

  // --- Dealing Phase ---

  takeFromDeck(actorId: string): boolean {
    const idx = this.getPlayerIdx(actorId);
    if (idx === -1 || this.state.phase !== 'DEALING' || !this.state.deck.length) return false;
    const outOfTurn = idx !== this.state.turnIndex;

    // Only one unresolved card can be on the felt at any time. This is
    // synchronization, not automatic punishment of an opportunistic player.
    if (this.state.activeCard) {
      if (this.state.activeCard.ownerId === actorId) this.addPenalty(idx, 'Пытается вытянуть вторую карту');
      return false;
    }
    if (!outOfTurn && this.canMoveTopCard(actorId)) {
      const targetIdx = this.findOtherBeatTarget(idx);
      if (targetIdx !== -1) this.addPenalty(idx, 'Не кинул свою карту на ' + this.state.players[targetIdx].name);
    }

    const card = this.state.deck.pop()!;
    const isSpadeSix = card.rank === '6' && card.suit === 'spades';
    const isLast = this.state.deck.length === 0;
    const originalTop = this.state.players[idx].stumps.at(-1)!;
    if (isLast) this.state.trumpSuit = card.suit === 'spades' ? null : card.suit;
    this.previousDeckSuit = card.suit;
    this.state.lastDrawnPlayerIdx = idx;
    this.state.lastDrawEvent = {
      playerId: actorId, outOfTurn, forcedSelf: isSpadeSix || isLast, createdAt: Date.now()
    };

    // Record the suspected breach. No fine or forced card placement until
    // another player makes a correct accusation within 15 seconds.
    if (outOfTurn) this.addPenalty(idx, 'Вытянул карту вне очереди', card.id);
    if (isSpadeSix) this.addPenalty(idx, 'Вытянул пиковую шестёрку');

    // Spade six and the final deck card are special independent rules:
    // they remain on the drawer's own pile even if cheating goes unnoticed.
    if (isSpadeSix || isLast) {
      this.lockedDrawCards.push(card.id);
      this.state.players[idx].stumps.push(card);
      if (!outOfTurn && !this.canBeat(card, originalTop)) {
        this.state.turnIndex = (this.state.turnIndex + 1) % this.state.players.length;
      }
      this.checkPhaseEnd();
      return true;
    }

    // An undetected illicit draw behaves like a regular drawn card. The
    // real turn order remains unchanged; another player may still catch it.
    this.state.activeCard = { card, ownerId: actorId, fromDeck: true };
    return true;
  }

  takeFromPile(actorId: string, cardId: string): boolean {
    const idx = this.getPlayerIdx(actorId);
    if (idx === -1 || this.state.phase !== 'DEALING' || this.state.activeCard) return false;
    if (idx !== this.state.turnIndex) return false;

    const p = this.state.players[idx];
    if (p.stumps.length <= (this.state.underlaidCards === false ? 1 : 3)) return false; // Never lift an originally dealt card
    
    const top = p.stumps[p.stumps.length - 1];
    if (top.id !== cardId || this.lockedDrawCards.includes(cardId)) return false;

    p.stumps.pop();
    this.state.activeCard = { card: top, ownerId: actorId, fromDeck: false };
    return true;
  }

  moveTopTo(actorId: string, targetId: string): boolean {
    if (!this.canMoveTopCard(actorId) || this.state.activeCard) return false;
    const actor = this.state.players.find(p => p.id === actorId)!;
    const top = actor.stumps.at(-1)!;
    if (!this.state.players.some(p => p.id === targetId)) return false;
    if (!this.takeFromPile(actorId, top.id)) return false;
    if (this.placeActiveCard(actorId, targetId)) return true;
    actor.stumps.push(top);
    this.state.activeCard = null;
    return false;
  }

  drawTo(actorId: string, targetId: string): boolean {
    // Validate both participants BEFORE touching the deck. A malformed drop
    // must never consume a card or leave an unresolved active card behind.
    if (!this.state.players.some(p => p.id === actorId) ||
        !this.state.players.some(p => p.id === targetId) ||
        this.state.phase !== 'DEALING' || !this.state.deck.length ||
        this.state.activeCard) return false;
    if (!this.takeFromDeck(actorId)) return false;
    // Forced self cards (spade six / last card) have already landed.
    return !this.state.activeCard || this.placeActiveCard(actorId, targetId);
  }

  placeActiveCard(actorId: string, targetId: string): boolean {
    const actorIdx = this.getPlayerIdx(actorId);
    const targetIdx = this.getPlayerIdx(targetId);
    if (actorIdx < 0 || targetIdx < 0 || !this.state.activeCard) return false;
    if (this.state.activeCard.ownerId !== actorId) return false;
    const { card, fromDeck } = this.state.activeCard;
    // A lifted pile card cannot be 'dropped' back on the same pile to
    // manufacture a turn ending. It belongs to another player's pile.
    if (!fromDeck && actorIdx === targetIdx) return false;
    const opportunistic = actorIdx !== this.state.turnIndex && fromDeck &&
      this.state.lastDrawEvent?.playerId === actorId && this.state.lastDrawEvent.outOfTurn;
    if (actorIdx !== this.state.turnIndex && !opportunistic) return false;
    const isSelf = actorIdx === targetIdx;
    const top = this.state.players[targetIdx].stumps.at(-1)!;
    const legal = top ? this.canBeat(card, top) : isSelf;
    let first = -1;
    for (let i = 1; i < this.state.players.length; i++) {
      const idx = (actorIdx + i) % this.state.players.length;
      if (this.canBeat(card, this.state.players[idx].stumps.at(-1)!)) { first = idx; break; }
    }
    // Dishonest placements are allowed but may be called out for 15 seconds.
    if (!isSelf && !legal) this.addPenalty(actorIdx, 'Неверная последовательность', card.id);
    else if (isSelf && first !== -1) this.addPenalty(actorIdx, 'Не перекинул карту сопернику', card.id);
    else if (!isSelf && first !== -1 && first !== targetIdx) {
      this.addPenalty(actorIdx, 'Пропустил игрока по кругу', card.id);
    }
    this.state.players[targetIdx].stumps.push(card);
    this.state.activeCard = null;
    // A valid drop on another player continues the chain.
    if (!opportunistic && (isSelf || !legal)) {
      this.state.turnIndex = (actorIdx + 1) % this.state.players.length;
    }
    this.checkPhaseEnd();
    return true;
  }

  private findOtherBeatTarget(actorIdx: number): number {
    const p = this.state.players[actorIdx];
    if (p.stumps.length <= (this.state.underlaidCards === false ? 1 : 3)) return -1;
    const top = p.stumps[p.stumps.length - 1];
    for (let i = 1; i < this.state.players.length; i++) {
      const idx = (actorIdx + i) % this.state.players.length;
      if (this.canBeat(top, this.state.players[idx].stumps[this.state.players[idx].stumps.length - 1])) return idx;
    }
    return -1;
  }

  private checkPhaseEnd() {
    if (this.state.phase === 'DEALING' && this.state.deck.length === 0 && !this.state.activeCard) {
      this.enterReview();
    }
  }

  private buildPenaltyQueue(): { giverId: string; receiverId: string }[] {
    const queue: { giverId: string; receiverId: string }[] = [];
    const debts = Object.fromEntries(Object.entries(this.penaltyDebts).map(([receiver, givers]) => [receiver, { ...givers }]));
    // Give one card per player in seat order, then repeat while debts remain.
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

  currentPenaltyTurn(): { giverId: string; receiverId: string } | null {
    return this.penaltyQueue[0] || null;
  }

  private transitionToPenaltyDistribution() {
    this.lockedDrawCards = [];
    this.state.phase = 'PENALTY_DISTRIBUTION';
    for (const p of this.state.players) p.hand = p.stumps.splice(this.state.underlaidCards === false ? 0 : 2);
    this.penaltyDebts = {};
    // A player must retain at least one card. Distribute the available
    // penalty cards without creating debts that can never be paid.
    for (const giver of this.state.players) {
      let available = Math.max(0, giver.hand.length - 1);
      for (const receiver of this.state.players) {
        if (giver.id === receiver.id || receiver.penalties <= 0 || available <= 0) continue;
        const owed = Math.min(receiver.penalties, available);
        (this.penaltyDebts[receiver.id] ??= {})[giver.id] = owed;
        available -= owed;
      }
    }
    const total = Object.values(this.penaltyDebts).flatMap(x => Object.values(x)).reduce((a, b) => a + b, 0);
    this.penaltyQueue = this.buildPenaltyQueue();
    if (total === 0) this.transitionToMainGame();
  }

  givePenaltyCard(giverId: string, cardId: string, receiverId: string): boolean {
    const giver = this.state.players.find(p => p.id === giverId);
    const current = this.currentPenaltyTurn();
    if (!giver || giver.hand.length <= 1 || current?.giverId !== giverId || current.receiverId !== receiverId || !this.penaltyDebts[receiverId]?.[giverId]) return false;
    const idx = giver.hand.findIndex(c => c.id === cardId);
    if (idx === -1) return false;
    this.state.players.find(p => p.id === receiverId)!.hand.push(giver.hand.splice(idx, 1)[0]);
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
    this.state.phase = 'MAIN_GAME';
    this.state.trickTargetId = null;
    this.state.turnIndex = ((this.state.lastDrawnPlayerIdx ?? -1) + 1) % this.state.players.length;
    while (this.state.players[this.state.turnIndex].hasExited) this.state.turnIndex = (this.state.turnIndex + 1) % this.state.players.length;
  }

  // --- Main Game ---

  playCard(playerId: string, cardId: string) {
    const idx = this.getPlayerIdx(playerId);
    if (idx !== this.state.turnIndex) { this.addPenalty(idx, "Вне очереди"); return; }
    const player = this.state.players[idx];
    const cIdx = player.hand.findIndex(c => c.id === cardId);
    if (cIdx === -1) return;
    const card = player.hand[cIdx];
    const target = this.state.currentTrick.length > 0 ? this.state.currentTrick[this.state.currentTrick.length - 1] : null;
    if (this.isLegalMove(card, target)) {
      player.hand.splice(cIdx, 1);
      this.state.currentTrick.push(card);
      // Each played card is placed in front of the next player clockwise.
      this.advanceTurn();
      this.state.trickTargetId = this.state.players[this.state.turnIndex]?.id || null;
      this.checkTrickCompletion();
    } else this.addPenalty(idx, "Не бьет");
  }

  isLegalMove(card: Card, target: Card | null): boolean {
    if (!target) return true;
    // Main game: same suit and any higher rank. This is deliberately
    // distinct from the consecutive-rank-only dealing phase.
    if (card.rank === '6' && target.rank === 'A' && card.suit === target.suit) {
      return card.suit !== 'spades';
    }
    const higher = RANK_VALUE[card.rank] > RANK_VALUE[target.rank];
    if (!this.state.trumpSuit) return card.suit === target.suit && higher;
    if (target.rank === 'A' && (target.suit === 'spades' || target.suit === this.state.trumpSuit)) return false;
    if (target.suit === 'spades') return card.suit === 'spades' && higher;
    if (target.suit === this.state.trumpSuit) return card.suit === this.state.trumpSuit && higher;
    if (card.suit === this.state.trumpSuit) return true;
    return card.suit === target.suit && higher;
  }

  takeTrick(playerId: string) {
    const idx = this.getPlayerIdx(playerId);
    if (idx !== this.state.turnIndex || this.state.currentTrick.length === 0) return;
    this.state.players[idx].hand.push(this.state.currentTrick.shift()!);
    this.advanceTurn();
    this.state.trickTargetId = this.state.currentTrick.length ? this.state.players[this.state.turnIndex]?.id || null : null;
  }

  takeStumps(playerId: string) {
    const p = this.state.players.find(p => p.id === playerId);
    if (p && this.state.phase === 'MAIN_GAME' && p.hand.length === 0 && this.state.currentTrick.length === 0) {
      p.hand.push(...p.stumps);
      p.stumps = [];
    }
  }

  exitGame(playerId: string) {
    const p = this.state.players.find(p => p.id === playerId);
    if (p && this.state.phase === 'MAIN_GAME' && this.state.currentTrick.length === 0 && p.hand.length === 0 && p.stumps.length === 0) {
      if (p.hasExited) return;
      p.hasExited = true;
      const remaining = this.state.players.filter(p => !p.hasExited);
      if (remaining.length <= 1) {
        if (remaining.length) remaining[0].onDuty = true;
        this.state.phase = 'ENDED';
      } else if (this.state.players[this.state.turnIndex]?.id === playerId) {
        this.advanceTurn();
      }
    }
  }

  private advanceTurn() {
    let next = (this.state.turnIndex + 1) % this.state.players.length;
    while (this.state.players[next].hasExited) next = (next + 1) % this.state.players.length;
    this.state.turnIndex = next;
  }

  private checkTrickCompletion() {
    const count = this.state.players.filter(p => !p.hasExited).length;
    if (this.state.currentTrick.length === count) {
      this.state.discardPile.push(...this.state.currentTrick);
      this.state.currentTrick = [];
      this.state.trickTargetId = null;
    }
  }
}

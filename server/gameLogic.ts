import type { Card, Suit, Rank, GameState } from '../shared/types.js';

export const RANKS: Rank[] = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUITS: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];

export const VIOLATION_WINDOW_MS = 15_000;
export interface RuleViolation { id: string; playerId: string; reason: string; createdAt: number; }
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
  private violations: RuleViolation[] = [];
  private lastAccusationAt: Record<string, number> = {};
  onPenalty: ((playerId: string, reason: string) => void) | null = null;

  snapshot() { return { state: this.state, penaltyDebts: this.penaltyDebts, penaltyQueue: this.penaltyQueue, previousDeckSuit: this.previousDeckSuit, violations: this.violations, lastAccusationAt: this.lastAccusationAt }; }
  restore(saved: { state: GameState; penaltyDebts?: Record<string, Record<string, number>>; penaltyQueue?: { giverId: string; receiverId: string }[]; previousDeckSuit?: Suit | null; violations?: RuleViolation[]; lastAccusationAt?: Record<string, number> }) {
    this.state = saved.state;
    this.penaltyDebts = saved.penaltyDebts || {};
    this.penaltyQueue = saved.penaltyQueue || this.buildPenaltyQueue();
    this.previousDeckSuit = saved.previousDeckSuit || null;
    this.violations = saved.violations || [];
    this.lastAccusationAt = saved.lastAccusationAt || {};
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
      discardPile: [],
      turnIndex: 0,
      lastDrawnPlayerIdx: null,
      activeCard: null
    };
  }

  start() {
    this.violations = [];
    this.lastAccusationAt = {};
    this.state.deck = createDeck();
    for (const player of this.state.players) {
      player.stumps = [this.state.deck.pop()!, this.state.deck.pop()!, this.state.deck.pop()!];
      player.hand = [];
    }
    this.state.trumpSuit = null;
    this.previousDeckSuit = null;
    this.state.phase = 'DEALING'; 
    this.state.turnIndex = 0;
    console.log("[GAME] Started. First turn:", this.state.players[0].name);
  }

  canBeat(card: Card, target: Card): boolean {
    // A six beats an ace when placed on it, but aces still beat ordinary sixes.
    return card.rank === '6' && target.rank === 'A'
      ? true : RANK_VALUE[card.rank] > RANK_VALUE[target.rank];
  }

  private getPlayerIdx(id: string) { return this.state.players.findIndex(p => p.id === id); }

  /**
   * Record an observable violation; never award a penalty automatically.
   * Another player must explicitly accuse the offender for it to count.
   */
  addPenalty(idx: number, reason: string): void {
    if (idx < 0 || this.state.phase === 'LOBBY' || this.state.phase === 'ENDED') return;
    const offenderId = this.state.players[idx]?.id;
    if (!offenderId) return;
    const now = Date.now();
    this.violations = this.violations.filter(v => now - v.createdAt < VIOLATION_WINDOW_MS);
    // Unnoticed violations expire after 15 seconds: no retroactive fines.
    // Repeated requests for the same invalid action do not stack accusations.
    if (this.violations.some(v => v.playerId === offenderId && v.reason === reason && now - v.createdAt < 2500)) return;
    this.violations.push({ id: crypto.randomUUID(), playerId: offenderId, reason, createdAt: now });
    if (this.violations.length > 80) this.violations.shift();
  }

  accusableTargets(observerId: string): string[] {
    const now = Date.now();
    if (!this.state.players.some(p => p.id === observerId)) return [];
    return [...new Set(this.violations.filter(v => v.playerId !== observerId && now - v.createdAt < VIOLATION_WINDOW_MS).map(v => v.playerId))];
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
    const reason = correct ? this.violations.splice(index, 1)[0].reason : 'Ложное обвинение';
    const punished = correct ? accused : accuser;
    punished.penalties++;
    this.onPenalty?.(punished.id, reason);
    return { correct, accusedId, penalizedId: punished.id, reason };
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
    for (const player of this.state.players) player.isReady = !!player.isBot;
  }

  // --- Dealing Phase ---

  takeFromDeck(actorId: string): boolean {
    const idx = this.getPlayerIdx(actorId);
    if (idx === -1 || this.state.phase !== 'DEALING' || this.state.activeCard) return false;
    
    if (idx !== this.state.turnIndex) {
      this.addPenalty(idx, "Тянешь вне очереди");
      return false;
    }

    const tIdx = this.findOtherBeatTarget(idx);
    if (tIdx !== -1) {
      this.addPenalty(idx, `Не кинул свою карту на ${this.state.players[tIdx].name}`);
    }

    if (this.state.deck.length === 0) return false;
    
    const card = this.state.deck.pop()!;
    if (this.state.deck.length === 0) {
      // The last card establishes the trump suit. A final spade uses
      // the previous drawn card's suit; two final spades mean no trump.
      this.state.trumpSuit = card.suit === 'spades'
        ? (this.previousDeckSuit === 'spades' ? null : this.previousDeckSuit)
        : card.suit;
    }
    this.previousDeckSuit = card.suit;
    this.state.activeCard = { card, ownerId: actorId, fromDeck: true };
    this.state.lastDrawnPlayerIdx = idx;
    return true;
  }

  takeFromPile(actorId: string, cardId: string): boolean {
    const idx = this.getPlayerIdx(actorId);
    if (idx === -1 || this.state.phase !== 'DEALING' || this.state.activeCard) return false;
    if (idx !== this.state.turnIndex) return false;

    const p = this.state.players[idx];
    if (p.stumps.length <= 3) return false; // Starting card stays
    
    const top = p.stumps[p.stumps.length - 1];
    if (top.id !== cardId) return false;

    p.stumps.pop();
    this.state.activeCard = { card: top, ownerId: actorId, fromDeck: false };
    return true;
  }

  placeActiveCard(actorId: string, targetId: string): boolean {
    const actorIdx = this.getPlayerIdx(actorId);
    const targetIdx = this.getPlayerIdx(targetId);
    if (actorIdx === -1 || targetIdx === -1 || !this.state.activeCard) return false;
    
    if (actorIdx !== this.state.turnIndex) {
      this.addPenalty(actorIdx, "Ход вне очереди");
      return false;
    }

    const { card, fromDeck } = this.state.activeCard;
    const actor = this.state.players[actorIdx];
    const target = this.state.players[targetIdx];
    const targetTop = target.stumps[target.stumps.length - 1];
    const isSelf = actorIdx === targetIdx;
    
    const beatsTarget = this.canBeat(card, targetTop);
    const isLastDeckCard = fromDeck && this.state.deck.length === 0;

    // Rule: Last deck card always to self
    if (isLastDeckCard) {
      if (!isSelf) this.addPenalty(actorIdx, "Последняя карта колоды - твоя");
      this.state.players[actorIdx].stumps.push(card);
      this.state.activeCard = null;
      this.state.turnIndex = (this.state.turnIndex + 1) % this.state.players.length;
      this.checkPhaseEnd();
      return true;
    }

    // Check if anyone else in circle is a better target
    let firstPriorityIdx = -1;
    for (let i = 1; i < this.state.players.length; i++) {
      const checkIdx = (actorIdx + i) % this.state.players.length;
      if (this.canBeat(card, this.state.players[checkIdx].stumps[this.state.players[checkIdx].stumps.length - 1])) {
        firstPriorityIdx = checkIdx;
        break;
      }
    }

    if (isSelf) {
      // Placing on self is ALWAYS ALLOWED
      if (firstPriorityIdx !== -1) {
        this.addPenalty(actorIdx, `Не кинул карту ${this.state.players[firstPriorityIdx].name}, хотя мог`);
      }
      target.stumps.push(card);
      this.state.activeCard = null;
      if (beatsTarget) {
         // beats self -> keep turn
      } else {
         this.state.turnIndex = (this.state.turnIndex + 1) % this.state.players.length;
      }
      this.checkPhaseEnd();
      return true;
    } else {
      // Placing on others: MUST beat them
      if (!beatsTarget) {
        this.addPenalty(actorIdx, "Карта не бьет мишень");
        return false;
      }
      if (firstPriorityIdx !== -1 && targetIdx !== firstPriorityIdx) {
        // Check if target is at least valid (already checked by beatsTarget) 
        // but maybe someone earlier in circle was missed
        let foundEarlier = false;
        for (let i = 1; i < this.state.players.length; i++) {
          const idx = (actorIdx + i) % this.state.players.length;
          if (idx === targetIdx) break;
          if (this.canBeat(card, this.state.players[idx].stumps[this.state.players[idx].stumps.length - 1])) {
             this.addPenalty(actorIdx, `Не первому по кругу (должен был ${this.state.players[idx].name})`);
             foundEarlier = true;
             break;
          }
        }
      }
      target.stumps.push(card);
      if (card.rank === '6' && targetTop.rank === 'A') this.addPenalty(targetIdx, "Схлопотал 6 на Туза");
      this.state.activeCard = null;
      // beats someone else -> keep turn
      this.checkPhaseEnd();
      return true;
    }
  }

  private findOtherBeatTarget(actorIdx: number): number {
    const p = this.state.players[actorIdx];
    if (p.stumps.length <= 3) return -1;
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
    this.state.phase = 'PENALTY_DISTRIBUTION';
    for (const p of this.state.players) p.hand = p.stumps.splice(2);
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
    this.penaltyQueue = [];
    this.state.phase = 'MAIN_GAME';
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
      this.advanceTurn();
      this.checkTrickCompletion();
    } else this.addPenalty(idx, "Не бьет");
  }

  isLegalMove(card: Card, target: Card | null): boolean {
    if (!target) return true;
    if (target.rank === 'A' && (target.suit === 'spades' || target.suit === this.state.trumpSuit)) return false;
    if (target.suit === 'spades') return card.suit === 'spades' && this.canBeat(card, target);
    if (target.suit === this.state.trumpSuit) return card.suit === this.state.trumpSuit && this.canBeat(card, target);
    if (card.suit === this.state.trumpSuit) return true;
    return card.suit === target.suit && this.canBeat(card, target);
  }

  takeTrick(playerId: string) {
    const idx = this.getPlayerIdx(playerId);
    if (idx !== this.state.turnIndex || this.state.currentTrick.length === 0) return;
    this.state.players[idx].hand.push(this.state.currentTrick.shift()!);
    this.advanceTurn();
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
    }
  }
}

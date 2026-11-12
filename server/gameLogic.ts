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
      player. --- TRUNCATED --- 23,348 chars
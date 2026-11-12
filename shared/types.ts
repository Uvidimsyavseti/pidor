export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Rank = '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  suit: Suit;
  rank: Rank;
  id: string;
}
export type GamePhase = 'LOBBY' | 'DEALING' | 'PENALTY_REVIEW' | 'PENALTY_DISTRIBUTION' | 'MAIN_GAME' | 'ENDED';
export interface Player {
  id: string;
  name: string;
  hand: Card[];
  stumps: Card[];
  penalties: number;
  isReady: boolean;
  onDuty: boolean;
  hasExited: boolean;
  isBot?: boolean;
}
export interface CardDrawReveal {
  id: string;
  playerId: string;
  card: Card;
  before: number;
  after: number;
  targetPlayerId?: string;
  createdAt?: number;
}
export interface GameState {
  phase: GamePhase;
  players: Player[];
  deck: Card[];
  trumpSuit: Suit | null;
  attackerId: string | null;
  trickTargetId?: string | null;
  currentTrick: Card[];
  discardPile: Card[];
  turnIndex: number;
  lastDrawnPlayerIdx: number | null;
  activeCard: { card: Card; ownerId: string; fromDeck: boolean } | null;
  underlaidCards?: boolean;
  mode?: 'friends' | 'bot';
  hostId?: string;
  initialDealAt?: number;
  initialDealEndsAt?: number;
  reviewDeadlineAt?: number;
  accusablePlayerIds?: string[];
  lastDrawEvent?: { playerId: string; outOfTurn: boolean; forcedSelf: boolean; createdAt: number };
  pendingPenaltyDebts?: Record<string, Record<string, number>>;
  pendingPenaltyTurn?: { giverId: string; receiverId: string } | null;
}
export interface TableListing {
  id: string;
  title: string;
  visibility: 'public' | 'private';
  underlaidCards: boolean;
  phase: GamePhase;
  seats: number;
  capacity: number;
  players: string[];
  createdAt: number;
  updatedAt: number;
}

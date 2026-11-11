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
  stumps: Card[]; // [faceDown, faceDown, faceUp, ...additionalCards]
  penalties: number; // "Хуёвые"
  isReady: boolean;
  onDuty: boolean; // "На вахте"
  hasExited: boolean; // "С пидорами не играю"
  isBot?: boolean;
}

export interface GameState {
  phase: GamePhase;
  mode?: 'friends' | 'bot';
  hostId?: string;
  players: Player[];
  deck: Card[];
  trumpSuit: Suit | null;
  attackerId: string | null; 
  currentTrick: Card[]; 
  discardPile: Card[];
  turnIndex: number; 
  lastDrawnPlayerIdx: number | null; 
  activeCard: { card: Card, ownerId: string, fromDeck: boolean } | null;
  lastDrawEvent?: { playerId: string; outOfTurn: boolean; forcedSelf: boolean; createdAt: number };
  pendingPenaltyDebts?: Record<string, Record<string, number>>;
  pendingPenaltyTurn?: { giverId: string; receiverId: string } | null; 
}

export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Rank = '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  suit: Suit;
  rank: Rank;
  id: string;
}

export type GamePhase = 'LOBBY' | 'DEALING' | 'PENALTY_DISTRIBUTION' | 'MAIN_GAME' | 'ENDED';

export interface Player {
  id: string;
  name: string;
  hand: Card[];
  stumps: Card[]; // [faceDown, faceDown, faceUp, ...additionalCards]
  penalties: number; // "Хуёвые"
  isReady: boolean;
  onDuty: boolean; // "На вахте"
  hasExited: boolean; // "С пидорами не играю"
}

export interface GameState {
  phase: GamePhase;
  players: Player[];
  deck: Card[];
  trumpSuit: Suit | null;
  attackerId: string | null; 
  currentTrick: Card[]; 
  discardPile: Card[];
  turnIndex: number; 
  lastDrawnPlayerIdx: number | null; 
  activeCard: { card: Card, ownerId: string, fromDeck: boolean } | null; 
}

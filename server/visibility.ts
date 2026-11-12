import type { Card, GameState } from '../shared/types.js';

function concealed(id: string): Card {
  return { id: 'masked-' + id, rank: '6', suit: 'clubs' };
}

/**
 * Face-down decks and private hands stay secret. The TOP of each dealing
 * pile and any face-up common-deck draw are visible to EVERY participant.
 */
export function visibleState(state: GameState, viewerId: string): GameState {
  const view: GameState = structuredClone(state);
  view.deck = state.deck.map((_, i) => concealed('deck-' + i));
  view.players = view.players.map(player => {
    const original = state.players.find(p => p.id === player.id)!;
    if (player.id !== viewerId) {
      player.hand = original.hand.map((_, i) => concealed('hand-' + i));
    }
    player.stumps = original.stumps.map((card, i) =>
      state.phase === 'DEALING' && i === original.stumps.length - 1 &&
        i >= (state.underlaidCards === false ? 0 : 2)
        ? card : concealed('stumps-' + player.id + '-' + i));
    return player;
  });
  // Intentionally do not mask activeCard: a common-deck draw is public.
  return view;
}

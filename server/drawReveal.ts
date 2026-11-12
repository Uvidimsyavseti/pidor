import type { Card, CardDrawReveal } from '../shared/types.js';

/**
 * Emit only for a real, successful pop from the shared deck.
 * A draw is public knowledge in the DEALING phase. No concealed player
 * hand card is ever passed to this helper.
 */
export function createDrawReveal(
  playerId: string,
  topBeforeDraw: Card | undefined,
  deckLengthBefore: number,
  deckLengthAfter: number,
  targetPlayerId?: string
): CardDrawReveal | null {
  if (!playerId || !topBeforeDraw || deckLengthBefore !== deckLengthAfter + 1) return null;
  return {
    id: crypto.randomUUID(),
    playerId,
    card: { ...topBeforeDraw },
    ...(targetPlayerId ? { targetPlayerId } : {}),
    createdAt: Date.now()
  };
}

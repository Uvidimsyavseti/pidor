/**
 * Server-side anti-replay window for state-mutating WebSocket actions.
 * The room stores this small rolling history with its game snapshot so a
 * reconnect cannot apply an already-accepted action for a second time.
 */
export type ActionHistory = Record<string, string[]>;
const MAX_ACTIONS_PER_PLAYER = 96;
const ACTION_ID_FORMAT = /^[A-Za-z0-9_-]{8,64}$/;

export function rememberAction(
  history: ActionHistory, playerId: string, actionId: string
): boolean {
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

export const STATE_CHANGING_ACTIONS = new Set([
  'startGame', 'accusePlayer', 'finishReview', 'drawTo', 'moveTopTo',
  'drawCardFromDeck', 'takeFromPile', 'placeActiveCard', 'givePenaltyCard',
  'playCard', 'takeTrick', 'takeStumps', 'exitGame'
]);
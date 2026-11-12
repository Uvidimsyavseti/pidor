/** One card per seat, clockwise, in each dealing round.
 * Without underlaid cards: one face-up round.
 * With underlaid cards: two face-down rounds, then one face-up round.
 */
export const INITIAL_DEAL_STEP_MS = 280;
export const INITIAL_DEAL_LEAD_MS = 350;
export const INITIAL_DEAL_FINISH_MS = 350;
export function initialCardCount(withUnderlaid: boolean): number {
  return withUnderlaid ? 3 : 1;
}
export function makeInitialDealSteps(
  playerIds: readonly string[],
  withUnderlaid: boolean
): { playerId: string; round: number; faceUp: boolean }[] {
  const rounds = initialCardCount(withUnderlaid);
  const steps: { playerId: string; round: number; faceUp: boolean }[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const playerId of playerIds) {
      steps.push({ playerId, round, faceUp: round === rounds - 1 });
    }
  }
  return steps;
}
export function initialDealDuration(playerCount: number, withUnderlaid: boolean): number {
  return initialCardCount(withUnderlaid) * playerCount * INITIAL_DEAL_STEP_MS + INITIAL_DEAL_FINISH_MS;
}

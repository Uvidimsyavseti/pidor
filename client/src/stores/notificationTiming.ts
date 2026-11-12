// All notices are deliberately short-lived and must not block the table.
export const PENALTY_NOTICE_MS = 2050;
export const ACCUSATION_VERDICT_MS = 2050;
export const PENALTY_SPLASH_MS = 1550;
export const CARD_REVEAL_MS = 1700;

type TimeoutScheduler = (callback: () => void, milliseconds: number) => unknown;

/**
 * Stale timeouts must not dismiss a newer notification of the same kind.
 * Optional scheduler injection allows deterministic tests without sleeping.
 */
export function clearCurrentAfter<T>(
  expected: T,
  current: () => T,
  clear: () => void,
  milliseconds: number,
  schedule: TimeoutScheduler = (callback, delay) => setTimeout(callback, delay)
): void {
  schedule(() => {
    if (current() === expected) clear();
  }, milliseconds);
}

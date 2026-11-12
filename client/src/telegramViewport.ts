type Insets = { top?: number; bottom?: number; left?: number; right?: number };
type MiniApp = {
  initData?: string;
  initDataUnsafe?: { user?: { first_name?: string; username?: string } };
  ready?: () => void;
  expand?: () => void;
  requestFullscreen?: () => void;
  disableVerticalSwipes?: () => void;
  onEvent?: (event: string, callback: () => void) => void;
  offEvent?: (event: string, callback: () => void) => void;
  safeAreaInset?: Insets;
  contentSafeAreaInset?: Insets;
  viewportHeight?: number;
  viewportStableHeight?: number;
};
declare global {
  interface Window { Telegram?: { WebApp?: MiniApp } }
}

function px(value: number | undefined): string { return (Number.isFinite(value) ? Math.max(0, value!) : 0) + 'px'; }

export function requestTelegramFullscreen(): void {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  try { tg.expand?.(); } catch { /* unavailable */ }
  try { tg.disableVerticalSwipes?.(); } catch { /* unavailable */ }
  try { tg.requestFullscreen?.(); } catch { /* needs a gesture on some clients */ }
}

export function mountTelegramViewport(): () => void {
  const tg = window.Telegram?.WebApp;
  const root = document.documentElement;
  if (tg) root.classList.add('telegram-mini-app');
  let raf = 0;
  let height = 0;

  const sync = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const safe = tg?.safeAreaInset || {};
      const content = tg?.contentSafeAreaInset || {};
      // Telegram's Close / More overlay is not included in safeAreaInset on some iOS clients.
      // Reserve a conservative top strip even when Telegram reports zero insets.
      root.style.setProperty('--tg-safe-top', px(Math.max(safe.top || 0, content.top || 0, tg ? 96 : 0)));
      root.style.setProperty('--tg-safe-bottom', px(Math.max(safe.bottom || 0, content.bottom || 0)));
      root.style.setProperty('--tg-safe-left', px(Math.max(safe.left || 0, content.left || 0)));
      root.style.setProperty('--tg-safe-right', px(Math.max(safe.right || 0, content.right || 0)));
      const vh = tg?.viewportStableHeight || tg?.viewportHeight || window.visualViewport?.height || window.innerHeight;
      if (vh && Math.abs(vh - height) >= 1) {
        height = vh;
        root.style.setProperty('--app-vh', Math.round(vh) + 'px');
      }
    });
  };
  try { tg?.ready?.(); } catch { /* Telegram not available */ }
  requestTelegramFullscreen();

  sync();
  window.addEventListener('resize', sync, { passive: true });
  window.visualViewport?.addEventListener('resize', sync, { passive: true });
  tg?.onEvent?.('viewportChanged', sync);
  tg?.onEvent?.('safeAreaChanged', sync);
  tg?.onEvent?.('contentSafeAreaChanged', sync);
  tg?.onEvent?.('fullscreenChanged', sync);
  return () => {
    cancelAnimationFrame(raf);
    root.classList.remove('telegram-mini-app');
    window.removeEventListener('resize', sync);
    window.visualViewport?.removeEventListener('resize', sync);
    tg?.offEvent?.('viewportChanged', sync);
    tg?.offEvent?.('safeAreaChanged', sync);
    tg?.offEvent?.('contentSafeAreaChanged', sync);
    tg?.offEvent?.('fullscreenChanged', sync);
  };
}

type Insets = { top?: number; bottom?: number; left?: number; right?: number };
type MiniApp = {
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

export function mountTelegramViewport(): () => void {
  const tg = window.Telegram?.WebApp;
  const root = document.documentElement;
  let raf = 0;
  let height = 0;

  const sync = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const safe = tg?.safeAreaInset || {};
      const content = tg?.contentSafeAreaInset || {};
      root.style.setProperty('--tg-safe-top', px(Math.max(safe.top || 0, content.top || 0)));
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
  try { tg?.expand?.(); } catch { /* Telegram not available */ }
  try { tg?.disableVerticalSwipes?.(); } catch { /* unsupported */ }
  // Fullscreen requires permission or gesture in some Telegram clients. Keep safe area regardless.
  try { tg?.requestFullscreen?.(); } catch { /* unsupported */ }

  sync();
  window.addEventListener('resize', sync, { passive: true });
  window.visualViewport?.addEventListener('resize', sync, { passive: true });
  tg?.onEvent?.('viewportChanged', sync);
  tg?.onEvent?.('safeAreaChanged', sync);
  tg?.onEvent?.('contentSafeAreaChanged', sync);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', sync);
    window.visualViewport?.removeEventListener('resize', sync);
    tg?.offEvent?.('viewportChanged', sync);
    tg?.offEvent?.('safeAreaChanged', sync);
    tg?.offEvent?.('contentSafeAreaChanged', sync);
  };
}

import { ref } from 'vue';

export const cardPackAvailable = ref(false);
let discovery: Promise<void> | undefined;

export function checkCardPack(): Promise<void> {
  if (!discovery) {
    discovery = fetch('/cards/manifest.json', { cache: 'force-cache' })
      .then(response => response.ok ? response.json() : null)
      .then(data => { cardPackAvailable.value = data?.pack === 'pidor-ornamental-36'; })
      .catch(() => { cardPackAvailable.value = false; });
  }
  return discovery;
}

/** Precache the ornamental faces early so the very first deck draw does not
 * stall on fetching and decoding an image after the server reveals its rank.
 * The server still determines the card; we never predict or leak deck order.
 */
let warming: Promise<void> | undefined;
export function warmCardFaces(): Promise<void> {
  if (warming) return warming;
  warming = checkCardPack().then(async () => {
    if (!cardPackAvailable.value || typeof Image === 'undefined') return;
    const ranks=['06','07','08','09','10','J','Q','K','A'];
    const suits=['C','D','H','S'];
    const paths=['/cards/BACK_COMMON.webp',...ranks.flatMap(rank=>suits.map(suit=>'/cards/'+rank+'_'+suit+'.webp'))];
    // A bounded worker pool avoids flooding Telegram's in-app WebView.
    let next=0;
    async function warmNext(): Promise<void> {
      while (next<paths.length) {
        const path=paths[next++]!;
        await new Promise<void>(resolve => {
          const pic=new Image();
          pic.onload=()=>resolve();
          pic.onerror=()=>resolve();
          pic.src=path;
          if (pic.complete) resolve();
        });
      }
    }
    await Promise.all(Array.from({length:Math.min(6,paths.length)},()=>warmNext()));
  }).catch(()=>{});
  return warming;
}

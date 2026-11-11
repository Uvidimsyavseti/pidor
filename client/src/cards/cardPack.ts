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

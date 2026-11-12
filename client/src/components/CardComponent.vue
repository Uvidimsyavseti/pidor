<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { cardPackAvailable, checkCardPack } from '../cards/cardPack';
import type { Card, Rank, Suit } from '@shared/types';

const props = defineProps<{ card?: Card; hidden?: boolean; small?: boolean }>();
const artworkError = ref(false);
const SUIT_CODE: Record<Suit, string> = { clubs: 'C', diamonds: 'D', hearts: 'H', spades: 'S' };
const picture = computed(() =>
  props.hidden || !props.card || props.card.id.startsWith('masked-')
    ? '/cards/BACK_COMMON.webp'
    : '/cards/' + (Number.isFinite(Number(props.card.rank)) ? props.card.rank.padStart(2, '0') : props.card.rank) +
      '_' + SUIT_CODE[props.card.suit] + '.webp'
);
watch(picture, () => { artworkError.value = false; });
onMounted(() => { void checkCardPack(); });

const suitSymbol: Record<Suit, string> = {
  hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠'
};
const rankLabel: Record<Rank, string> = {
  '6': '6', '7': '7', '8': '8', '9': '9', '10': '10', J: 'В', Q: 'Д', K: 'К', A: 'Т'
};
const faceName: Partial<Record<Rank, string>> = {
  J: 'ВАЛЕТ', Q: 'ДАМА', K: 'КОРОЛЬ', A: 'ТУЗ'
};
</script>

<template>
  <div
    class="playing-card"
    :class="{
      'playing-card--back': hidden,
      'playing-card--small': small,
      'playing-card--red': card?.suit === 'hearts' || card?.suit === 'diamonds',
      'playing-card--face': !hidden && !!card,
      'playing-card--court': !hidden && !!card && ['J','Q','K'].includes(card.rank)
    }"
    :aria-label="hidden ? 'Рубашка карты' : card ? rankLabel[card.rank] + ' ' + suitSymbol[card.suit] : 'Карта'"
  >
    <template v-if="cardPackAvailable && !artworkError">
      <img :src="picture" class="playing-card__art" :alt="hidden ? 'Рубашка' : (card?.rank || '') + ' ' + (card ? suitSymbol[card.suit] : '')"
        draggable="false" loading="eager" decoding="async" @error="artworkError = true" />
    </template>
    <template v-else-if="!hidden && card">
      <span class="playing-card__corner">
        <b>{{ rankLabel[card.rank] }}</b>
        <span>{{ suitSymbol[card.suit] }}</span>
      </span>
      <span class="playing-card__center" aria-hidden="true">
        <span class="playing-card__center-suit">{{ suitSymbol[card.suit] }}</span>
        <span v-if="faceName[card.rank]" class="playing-card__caption">{{ faceName[card.rank] }}</span>
      </span>
      <span class="playing-card__corner playing-card__corner--bottom" aria-hidden="true">
        <b>{{ rankLabel[card.rank] }}</b>
        <span>{{ suitSymbol[card.suit] }}</span>
      </span>
    </template>
    <template v-else>
      <span class="playing-card__back-border">
        <span class="playing-card__back-diamond"><span>P</span></span>
      </span>
    </template>
  </div>
</template>

<style scoped>
.playing-card {
  --width: clamp(60px, 7vw, 82px);
  position: relative;
  flex: none;
  display: block;
  width: var(--width);
  aspect-ratio: 2 / 3;
  overflow: hidden;
  border-radius: calc(var(--width) * .105);
  border: 1px solid rgba(255,255,255,.75);
  background: #fffef8;
  color: #26313d;
  box-shadow: 0 3px 0 rgba(0,0,0,.10), 0 8px 18px rgba(0,0,0,.24);
  user-select: none;
  -webkit-user-select: none;
}
.playing-card--small { --width: clamp(43px, 5.2vw, 56px); }
.playing-card__art { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: fill; pointer-events: none; -webkit-user-drag: none; }
.playing-card--face { background: transparent; }
.playing-card { transition: filter .18s ease, box-shadow .18s ease; }
.playing-card--face:hover { filter: brightness(1.055); }
.playing-card--red { color: #bf343e; }
.playing-card__corner {
  position: absolute;
  top: 6%;
  left: 8%;
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: .96;
  font-size: calc(var(--width) * .20);
  font-weight: 800;
}
.playing-card__corner span { font-size: 1.1em; }
.playing-card__corner--bottom { top: auto; left: auto; right: 8%; bottom: 6%; transform: rotate(180deg); }
.playing-card__center {
  position: absolute;
  inset: 22% 16%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3%;
}
.playing-card__center-suit {
  font-family: Georgia, serif;
  font-size: calc(var(--width) * .55);
  line-height: 1;
  filter: drop-shadow(0 2px 0 rgba(0,0,0,.06));
}
.playing-card--court .playing-card__center-suit { font-size: calc(var(--width) * .46); }
.playing-card__caption {
  font-size: calc(var(--width) * .095);
  font-weight: 900;
  letter-spacing: .08em;
}
.playing-card--back {
  border: 2px solid #c39d5d;
  background: repeating-linear-gradient(40deg, #173b49 0 4px, #21546a 4px 6px, #173b49 6px 12px);
  box-shadow: 0 2px 0 #102a35, 0 6px 14px rgba(0,0,0,.24);
}
.playing-card__back-border {
  position: absolute;
  inset: 5%;
  border: 1px solid rgba(241,213,154,.85);
  border-radius: 5px;
  display: grid;
  place-items: center;
  background: radial-gradient(ellipse at center, #245a64 0, #143746 72%);
}
.playing-card__back-diamond {
  display: grid;
  place-items: center;
  width: 54%;
  aspect-ratio: 1;
  transform: rotate(45deg);
  border: 2px double #dbbd81;
  background: #163c4a;
  box-shadow: 0 0 0 4px rgba(223,184,117,.14);
}
.playing-card__back-diamond span {
  transform: rotate(-45deg);
  color: #f7d899;
  font-family: Georgia, serif;
  font-size: calc(var(--width) * .31);
  font-weight: 700;
}
@media (max-width: 680px) {
  .playing-card { --width: 70px; }
  .playing-card--small { --width: 45px; }
}
@media (max-width: 370px) {
  .playing-card { --width: 62px; }
  .playing-card--small { --width: 41px; }
}
@media (prefers-reduced-motion: reduce) {
  .playing-card { transition: none; }
}
</style>

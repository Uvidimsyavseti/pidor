<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Card, Rank, Suit } from '@shared/types';

const props = withDefaults(defineProps<{ card?: Card; hidden?: boolean; small?: boolean; inert?: boolean }>(), {
  hidden: false,
  small: false,
  inert: false,
});

const failed = ref(false);
const rankText: Record<Rank, string> = { '6': '6', '7': '7', '8': '8', '9': '9', '10': '10', J: 'В', Q: 'Д', K: 'К', A: 'Т' };
const suitText: Record<Suit, string> = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const suitCodes: Record<Suit, string> = { hearts: 'H', diamonds: 'D', clubs: 'C', spades: 'S' };
const file = computed(() => {
  if (props.hidden || !props.card) return '/cards/BACK_COMMON.webp';
  const rank = /^[0-9]$/.test(props.card.rank) ? '0' + props.card.rank : props.card.rank === '10' ? '10' : props.card.rank;
  return '/cards/' + rank + '_' + suitCodes[props.card.suit] + '.webp';
});
const red = computed(() => props.card?.suit === 'hearts' || props.card?.suit === 'diamonds');
</script>

<template>
  <div
    class="playing-card"
    :class="{ 'playing-card--small': small, 'playing-card--back': hidden, 'playing-card--red': red, 'playing-card--inert': inert }"
    :data-card-id="card?.id"
    aria-hidden="true"
  >
    <img v-if="!failed" :src="file" alt="" draggable="false" @error="failed = true" />
    <div v-else-if="hidden || !card" class="playing-card__fallback-back"><i>✦</i></div>
    <div v-else class="playing-card__fallback-front">
      <b>{{ rankText[card.rank] }}</b>
      <strong>{{ suitText[card.suit] }}</strong>
      <b>{{ rankText[card.rank] }}</b>
    </div>
  </div>
</template>

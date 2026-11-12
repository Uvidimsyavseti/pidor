<script setup lang="ts">
import { computed } from 'vue';
import type { Card, Player } from '@shared/types';
import CardComponent from './CardComponent.vue';

const props = withDefaults(defineProps<{
  player: Player;
  isMe?: boolean;
  isTurn?: boolean;
  phase: string;
  selectedCardId?: string | null;
  hiddenCardIds?: ReadonlySet<string>;
}>(), { isMe: false, isTurn: false, selectedCardId: null });
const emit = defineEmits<{
  cardClick: [event: { card: Card; ownerId: string }];
  click: [];
}>();
const topCard = computed(() => props.player.stumps.at(-1));
const visibleStumps = computed(() => props.player.stumps.filter(c => !props.hiddenCardIds?.has(c.id)));
const handSize = computed(() => props.player.hand.length);
const closedStartCount = computed(() => props.player.stumps.length >= 3 ? 2 : 0);
function touchTop(e: Event) {
  e.stopPropagation();
  if (topCard.value && !props.hiddenCardIds?.has(topCard.value.id)) emit('cardClick', { card: topCard.value, ownerId: props.player.id });
}
</script>

<template>
  <div
    class="seat"
    :class="{ 'seat--me': isMe, 'seat--active': isTurn, 'seat--exited': player.hasExited }"
    :data-seat-id="player.id"
    @click="emit('click')"
  >
    <div class="seat__identity">
      <span class="seat__turn" v-if="isTurn" aria-label="Ход игрока">◆</span>
      <span class="seat__name">{{ player.name }}</span>
      <span v-if="player.penalties" class="seat__penalties" :aria-label="'Похуёвых: ' + player.penalties">☠ {{ player.penalties }}</span>
    </div>
    <div class="seat__cards" @click.stop="touchTop">
      <template v-if="phase === 'DEALING'">
        <div
          v-for="(card, index) in visibleStumps"
          :key="card.id"
          class="seat__pile-card"
          :style="{ transform: 'translate(' + index * 1.2 + 'px,' + (-index * 1.2) + 'px)', zIndex: index }"
        >
          <CardComponent :card="card" :hidden="index < closedStartCount && index < 2" small />
        </div>
      </template>
      <template v-else>
        <div v-if="player.stumps.length" class="seat__pile-card">
          <CardComponent :card="player.stumps.at(-1)" :hidden="!isMe" small />
        </div>
        <div v-if="!isMe && handSize > 0" class="seat__closed-hand">
          <CardComponent hidden small />
        </div>
      </template>
    </div>
    <span v-if="phase === 'DEALING'" class="seat__count">{{ visibleStumps.length }} / {{ player.stumps.length }}</span>
    <span v-else-if="!isMe" class="seat__count">{{ handSize }} карт</span>
    <span v-if="player.hasExited" class="seat__status">Вышел</span>
  </div>
</template>

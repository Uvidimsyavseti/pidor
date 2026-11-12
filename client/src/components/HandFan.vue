<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { Card } from '@shared/types';
import CardComponent from './CardComponent.vue';

const props = withDefaults(defineProps<{ cards: Card[]; disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{ play: [card: Card]; select: [] }>();
const root = ref<HTMLElement | null>(null);
const index = ref(-1);
const pointerId = ref<number | null>(null);
const startX = ref(0);
const startY = ref(0);
const pos = ref({ x: 0, y: 0 });
const dragging = ref(false);
const snapping = ref(false);
const overTarget = ref(false);
const inFlight = ref(false);
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

const spread = computed(() => {
  const width = root.value?.clientWidth ?? 360;
  return Math.max(22, Math.min(62, (width - 84) / Math.max(props.cards.length - 1, 1)));
});
const fanWidth = computed(() => props.cards.length ? 84 + (props.cards.length - 1) * spread.value : 0);
const selected = computed(() => props.cards[index.value] ?? null);

function cardX(i: number) { return (i - (props.cards.length - 1) / 2) * spread.value; }
function cardAngle(i: number) { return Math.max(-18, Math.min(18, (i - (props.cards.length - 1) / 2) * 3.4)); }
function closest(clientX: number): number {
  const bounds = root.value?.getBoundingClientRect();
  if (!bounds || !props.cards.length) return -1;
  const local = clientX - (bounds.left + bounds.width / 2);
  return Math.max(0, Math.min(props.cards.length - 1, Math.round(local / spread.value + (props.cards.length - 1) / 2)));
}
function hitTarget(x: number, y: number) {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return Boolean(el?.closest('[data-drop-zone="trick"]'));
}
function pointerDown(e: PointerEvent) {
  if (props.disabled || inFlight.value || pointerId.value !== null || !props.cards.length) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  pointerId.value = e.pointerId;
  startX.value = e.clientX;
  startY.value = e.clientY;
  pos.value = { x: e.clientX, y: e.clientY };
  index.value = closest(e.clientX);
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  emit('select');
  e.preventDefault();
}
function pointerMove(e: PointerEvent) {
  if (e.pointerId !== pointerId.value) return;
  pos.value = { x: e.clientX, y: e.clientY };
  if (!dragging.value) {
    // Scrubbing horizontally only highlights; an intentional upward pull starts the drag.
    if (startY.value - e.clientY > 30) dragging.value = true;
    else if (Math.abs(startY.value - e.clientY) < 24) index.value = closest(e.clientX);
  }
  if (dragging.value) overTarget.value = hitTarget(e.clientX, e.clientY);
  e.preventDefault();
}
function endPointer(e: PointerEvent) {
  if (pointerId.value !== e.pointerId) return;
  const accepted = dragging.value && !props.disabled && hitTarget(e.clientX, e.clientY) && selected.value;
  pointerId.value = null;
  overTarget.value = false;
  if (accepted && selected.value) {
    inFlight.value = true;
    emit('play', selected.value);
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(reset, 450);
  } else if (dragging.value) {
    const card = root.value?.querySelectorAll<HTMLElement>('.hand-fan__slot')[index.value];
    const bounds = card?.getBoundingClientRect();
    if (bounds) {
      snapping.value = true;
      pos.value = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(reset, 240);
    } else reset();
  } else reset();
  if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
}
function reset() {
  pointerId.value = null;
  dragging.value = false;
  snapping.value = false;
  overTarget.value = false;
  inFlight.value = false;
  index.value = -1;
}
onBeforeUnmount(() => clearTimeout(releaseTimer));
</script>

<template>
  <div
    ref="root"
    class="hand-fan"
    :class="{ 'hand-fan--disabled': disabled }"
    aria-label="Ваши карты. Проведите пальцем для выбора, потяните вверх для хода"
    @pointerdown="pointerDown"
    @pointermove="pointerMove"
    @pointerup="endPointer"
    @pointercancel="endPointer"
    @lostpointercapture="(e: PointerEvent) => { if (e.pointerId === pointerId) reset(); }"
  >
    <div class="hand-fan__cards" :style="{ width: fanWidth + 'px' }">
      <div
        v-for="(card, i) in cards"
        :key="card.id"
        class="hand-fan__slot"
        :class="{ 'hand-fan__slot--active': i === index, 'hand-fan__slot--dragging': dragging && i === index }"
        :style="{ '--fan-x': cardX(i) + 'px', '--fan-angle': cardAngle(i) + 'deg', zIndex: i === index ? cards.length + 1 : i }"
      >
        <CardComponent :card="card" />
      </div>
    </div>
    <div v-if="dragging && selected" class="hand-fan__ghost"
      :class="{ 'hand-fan__ghost--snap': snapping, 'hand-fan__ghost--over': overTarget }"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }">
      <CardComponent :card="selected" />
    </div>
  </div>
</template>

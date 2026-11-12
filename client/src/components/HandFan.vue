<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Card } from '@shared/types';
import CardComponent from './CardComponent.vue';

const props = withDefaults(defineProps<{ cards: Card[]; disabled?: boolean; allowSeatDrop?: boolean }>(), { disabled: false, allowSeatDrop: false });
const emit = defineEmits<{ play: [card: Card]; give: [card: Card, receiverId: string]; choose: [card: Card]; select: []; hover: [over: boolean] }>();
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
let resize: ResizeObserver | undefined;
const width = ref(360);

const spread = computed(() => {
  return Math.max(5, Math.min(62, (width.value - 84) / Math.max(props.cards.length - 1, 1)));
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
function seatAt(x: number, y: number): string | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const seat = (element as HTMLElement).closest<HTMLElement>('[data-seat-id]');
    if (seat?.dataset.seatId) return seat.dataset.seatId;
  }
  return null;
}
function hitTarget(x: number, y: number) {
  if (props.allowSeatDrop) return Boolean(seatAt(x, y));
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
  if (dragging.value) {
    const over = hitTarget(e.clientX, e.clientY);
    if (overTarget.value !== over) { overTarget.value = over; emit('hover', over); }
  }
  e.preventDefault();
}
function endPointer(e: PointerEvent) {
  if (pointerId.value !== e.pointerId) return;
  const recipient = props.allowSeatDrop ? seatAt(e.clientX, e.clientY) : null;
  const accepted = dragging.value && !props.disabled && (props.allowSeatDrop ? Boolean(recipient) : hitTarget(e.clientX, e.clientY)) && selected.value;
  const simpleTap = !dragging.value && props.allowSeatDrop && selected.value;
  pointerId.value = null;
  overTarget.value = false;
  emit('hover', false);
  if (accepted && selected.value) {
    inFlight.value = true;
    const target = (recipient
      ? document.querySelector('[data-seat-id="' + CSS.escape(recipient) + '"] .seat__cards')
      : document.querySelector('.table__trick'))?.getBoundingClientRect();
    if (target) {
      snapping.value = true;
      pos.value = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
    }
    if (props.allowSeatDrop && recipient) emit('give', selected.value, recipient);
    else emit('play', selected.value);
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(reset, 450);
  } else if (simpleTap && selected.value) {
    emit('choose', selected.value);
    reset();
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
  emit('hover', false);
  inFlight.value = false;
  index.value = -1;
}
function cancelPointer(e: PointerEvent) {
  if (pointerId.value === e.pointerId) reset();
}
onMounted(() => {
  if (!root.value) return;
  width.value = root.value.clientWidth;
  resize = new ResizeObserver(entries => { width.value = entries[0]?.contentRect.width ?? width.value; });
  resize.observe(root.value);
});
onBeforeUnmount(() => { clearTimeout(releaseTimer); resize?.disconnect(); });
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
    @pointercancel="cancelPointer"
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

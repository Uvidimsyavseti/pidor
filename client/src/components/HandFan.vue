<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Card } from '@shared/types';
import CardComponent from './CardComponent.vue';

const props=defineProps<{
  cards: Card[];
  enabled: boolean;
  previewId?: string | null;
  movingCardId?: string | null;
  selectedCardId?: string | null;
}>();
const emit=defineEmits<{
  play: [card: Card];
  dragStart: [event: PointerEvent, card: Card];
}>();
const root=ref<HTMLElement|null>(null);
const availableWidth=ref(360);
const hovered=ref<string|null>(null);
let observer: ResizeObserver|null=null;

onMounted(()=>{
  if (root.value) {
    availableWidth.value=root.value.clientWidth||360;
    observer=new ResizeObserver(entries=>{
      const w=entries[0]?.contentRect.width;
      if (w) availableWidth.value=w;
    });
    observer.observe(root.value);
  }
});
onUnmounted(()=>observer?.disconnect());
const n=computed(()=>props.cards.length);
const width=computed(()=>Math.max(54,Math.min(91,availableWidth.value*.26)));
const gap=computed(()=>n.value<=1?0:Math.min(
  width.value*.74,
  Math.max(16,(availableWidth.value-width.value-12)/Math.max(1,n.value-1))
));
function cardStyle(index:number,card:Card) {
  const middle=(n.value-1)/2;
  const shift=(index-middle);
  const active=(props.previewId||hovered.value||props.selectedCardId)===card.id;
  return {
    '--fan-x':(shift*gap.value)+'px',
    '--fan-angle':(Math.max(-15,Math.min(15,shift*(n.value>8?3.1:4.7))))+'deg',
    '--fan-y':(Math.abs(shift)*Math.min(2.8,n.value>8?1.3:2))+'px',
    '--fan-width':width.value+'px',
    '--fan-lift':active?'-28px':'0px',
    zIndex:active?String(n.value+10):String(index+1)
  };
}
function begin(event:PointerEvent,card:Card) {
  if (!props.enabled) return;
  event.preventDefault();
  hovered.value=card.id;
  emit('dragStart',event,card);
}
function tapped(card:Card) {
  if (props.enabled) emit('play',card);
}
</script>

<template>
  <div ref="root" class="hand-fan" :class="{ 'hand-fan--disabled':!enabled }"
    :style="{ '--hand-card-count':cards.length }"
    aria-label="Твои карты веером">
    <div v-if="!cards.length" class="hand-fan__empty">Нет карт</div>
    <button v-for="(card,index) in cards" :key="card.id" type="button"
      class="hand-fan__card"
      :class="{
        'hand-fan__card--lifted':(previewId || hovered || selectedCardId) === card.id,
        'hand-fan__card--moving':movingCardId === card.id
      }"
      :style="cardStyle(index,card)"
      :data-hand-card-id="card.id"
      :aria-label="'Карта '+card.rank+' '+card.suit"
      :disabled="!enabled"
      @pointerenter="hovered=card.id"
      @pointerleave="hovered=hovered===card.id?null:hovered"
      @pointerdown.stop="begin($event,card)"
      @click.stop="tapped(card)">
      <CardComponent :card="card" />
    </button>
  </div>
</template>

<style scoped>
.hand-fan{
  position:relative;flex:1;min-width:0;width:100%;height:100%;
  overflow:visible;touch-action:none;user-select:none;-webkit-user-select:none;
  display:block;
}
.hand-fan__card{
  position:absolute;left:50%;bottom:-5px;
  padding:0;margin:0;border:0;background:none;
  cursor:grab;touch-action:none;
  transform-origin:50% 88%;
  transform:translate3d(calc(-50% + var(--fan-x)),calc(var(--fan-y) + var(--fan-lift)),0) rotate(var(--fan-angle));
  transition:transform .19s cubic-bezier(.16,.85,.27,1),filter .19s ease,opacity .14s ease;
  will-change:transform;
}
.hand-fan__card:active{cursor:grabbing;}
.hand-fan__card :deep(.playing-card){--width:var(--fan-width)!important;}
.hand-fan__card--lifted{filter:drop-shadow(0 13px 12px #010d0866);}
.hand-fan__card--moving{opacity:0;pointer-events:none;}
.hand-fan__empty{
  position:absolute;inset:0;display:grid;place-items:center;
  color:#cbb89c;font-size:12px;
}
.hand-fan--disabled .hand-fan__card{cursor:default;}
@media(max-width:430px){.hand-fan__card{bottom:-10px;}}
@media(prefers-reduced-motion:reduce){.hand-fan__card{transition:none;}}
</style>
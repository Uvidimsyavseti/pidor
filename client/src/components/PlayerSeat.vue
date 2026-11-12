<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Player, Card } from '@shared/types';
import CardComponent from './CardComponent.vue';
import HandFan from './HandFan.vue';

const props = defineProps<{
  player: Player;
  isMe: boolean;
  isTurn: boolean;
  phase: string;
  underlaidCards?: boolean;
  selectedCardId?: string | null;
  targetable?: boolean;
  recommended?: boolean;
  aimed?: boolean;
  flyingCardId?: string | null;
  incomingCard?: Card | null;
  incomingCount?: number;
  previewCardId?: string | null;
}>();
const emit = defineEmits<{
  cardClick: [payload: { card: Card; ownerId: string }];
  click: [];
  dragStart: [event: PointerEvent];
  handDragStart: [event: PointerEvent, card: Card];
}>();

const handExpanded = ref(false);
watch(() => props.phase, phase => {
  handExpanded.value = phase === 'MAIN_GAME' || phase === 'PENALTY_DISTRIBUTION';
}, { immediate: true });

function selectCard(card: Card) {
  if (card.id.startsWith('masked-')) return;
  emit('cardClick', { card, ownerId: props.player.id });
}
</script>

<template>
  <section
    class="seat"
    :class="{
      'seat--me': isMe,
      'seat--opponent': !isMe,
      'seat--turn': isTurn,
      'seat--target': targetable && !player.hasExited,
      'seat--recommended': recommended && targetable && !player.hasExited,
      'seat--aimed': aimed && targetable && !player.hasExited,
      'seat--exited': player.hasExited
    }"
    :data-player-id="player.id"
    @click="targetable && !player.hasExited ? emit('click') : undefined"
    @keydown.enter="targetable && !player.hasExited ? emit('click') : undefined"
    @keydown.space.prevent="targetable && !player.hasExited ? emit('click') : undefined"
    :tabindex="targetable && !player.hasExited ? 0 : undefined"
    :role="targetable && !player.hasExited ? 'button' : undefined"
    :aria-label="targetable ? 'Положить карту игроку ' + player.name : undefined"
  >
    <div class="seat__identity">
      <div class="seat__avatar">{{ player.name.slice(0, 1).toUpperCase() }}</div>
      <div class="seat__info">
        <div class="seat__name" :title="player.name">
          {{ player.name }}
          
        </div>
        <div v-if="player.hasExited || player.onDuty" class="seat__meta">
          {{ player.hasExited ? 'Вышел' : 'На вахте' }}
        </div>
      </div>
      <div class="seat__penalties" :title="'Похуёвые: ' + player.penalties" :aria-label="'Похуёвые: ' + player.penalties">
        <span aria-hidden="true">✕</span> {{ player.penalties }}
      </div>
      <span v-if="isTurn" class="seat__turn">ХОД</span>
    </div>

    <template v-if="!isMe">
      <div class="seat__opponent-cards">
        <div v-if="player.stumps.length" class="seat__pile"
          :class="{ 'seat__pile--moving': player.stumps[player.stumps.length-1]?.id === flyingCardId }">
          <CardComponent :key="player.stumps[player.stumps.length - 1]?.id"
            :card="['DEALING','PENALTY_REVIEW'].includes(phase) && player.stumps.length >= (underlaidCards === false ? 1 : 3) ? player.stumps[player.stumps.length - 1] : undefined"
            :hidden="!['DEALING','PENALTY_REVIEW'].includes(phase) || player.stumps.length < (underlaidCards === false ? 1 : 3)"
            small
          />
          <span class="seat__pile-count">{{ player.stumps.length }}</span>
        </div>
        <div v-else-if="player.hand.length" class="seat__pile seat__pile--hand" :aria-label="player.hand.length + ' карт в руке'">
          <CardComponent hidden small />
          <span class="seat__pile-count">{{ player.hand.length }}</span>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="seat__mine">
        <div v-if="phase === 'PENALTY_DISTRIBUTION'" class="seat__hand-heading">
          <div class="seat__hand-title">
            <span class="seat__section-label">{{ ['DEALING','PENALTY_REVIEW'].includes(phase) ? '' : 'ВАШИ КАРТЫ' }}</span>
            <span class="seat__hand-count">{{ ['DEALING','PENALTY_REVIEW'].includes(phase) ? player.stumps.length : player.hand.length }} карт</span>
          </div>
          <button
            v-if="!['DEALING','PENALTY_REVIEW'].includes(phase)"
            type="button"
            class="seat__expand-button"
            :aria-expanded="handExpanded"
            aria-controls="my-cards-area"
            @click.stop="handExpanded = !handExpanded"
          >{{ handExpanded ? 'Свернуть' : 'Раскрыть карты' }} <span aria-hidden="true">{{ handExpanded ? '⌄' : '⌃' }}</span></button>
        </div>

        <div v-if="['DEALING','PENALTY_REVIEW'].includes(phase)" class="seat__deal-area" data-testid="my-dealing-pile">
          <div v-if="player.stumps.length" class="seat__stack" :aria-label="'Стопка из ' + player.stumps.length + ' карт'">
            <div v-if="player.stumps.length > 1" class="seat__stack-layer seat__stack-layer--bottom"><CardComponent hidden /></div>
            <div v-if="player.stumps.length > 2" class="seat__stack-layer seat__stack-layer--middle"><CardComponent hidden /></div>
            <div :key="player.stumps[player.stumps.length - 1]?.id" class="seat__stack-layer seat__stack-layer--top"
              :class="{ 'seat__stack-layer--moving': player.stumps[player.stumps.length - 1]?.id === flyingCardId }">
              <button
                v-if="player.stumps.length > (underlaidCards === false ? 1 : 3) && isTurn"
                type="button"
                class="seat__card-button seat__stack-button"
                :aria-label="'Передать верхнюю карту ' + player.stumps[player.stumps.length - 1]?.rank + ' ' + player.stumps[player.stumps.length - 1]?.suit"
                @pointerdown.stop.prevent="emit('dragStart', $event)"
              ><CardComponent :card="player.stumps[player.stumps.length - 1]" /></button>
              <CardComponent v-else :card="player.stumps[player.stumps.length - 1]" />
            </div>
            <span class="seat__stack-count">{{ player.stumps.length }}</span>
          </div>
          <div v-else class="seat__empty-pile" aria-label="Пустая стопка"></div>
        </div>

        <div v-else class="seat__play-area" :class="{ 'seat__play-area--no-reserve': !player.stumps.length, 'seat__play-area--fan': phase === 'MAIN_GAME' }">
          <div v-if="player.stumps.length" class="seat__reserved">
            <span v-if="phase !== 'MAIN_GAME'" class="seat__section-label">СТОПКА · {{ player.stumps.length }}</span>
            <div class="seat__reserved-cards">
              <CardComponent v-if="player.stumps.length > 1" hidden small />
              <CardComponent v-if="player.stumps.length" hidden small />
            </div>
          </div>
          <HandFan v-if="phase === 'MAIN_GAME'"
            :cards="player.hand" :enabled="isTurn && !player.hasExited"
            :preview-id="previewCardId" :moving-card-id="flyingCardId"
            :selected-card-id="selectedCardId"
            @drag-start="(event,card) => emit('handDragStart',event,card)"
            @play="selectCard" />
          <div v-else
            id="my-cards-area"
            class="seat__hand-scroll"
            :class="{ 'seat__hand-scroll--expanded': handExpanded }"
            data-testid="my-hand"
          >
            <div v-if="!player.hand.length" class="seat__empty-hand">В руке пока нет карт</div>
            <button
              v-for="card in player.hand"
              :key="card.id"
              type="button"
              class="seat__card-button seat__hand-card"
              :class="{ 'seat__hand-card--selected': selectedCardId === card.id }"
              :data-card-id="card.id"
              :aria-label="'Сыграть ' + card.rank + ' ' + card.suit"
              @click.stop="selectCard(card)"
            ><CardComponent :card="card" /></button>
          </div>
        </div>
      </div>
    </template>
    <div v-if="incomingCard && phase === 'MAIN_GAME'" class="seat__incoming-card"
      :class="{ 'seat__incoming-card--mine': isMe }"
      :title="'Карта перед игроком ' + player.name" aria-label="Карта перед этим игроком">
      <CardComponent :card="incomingCard" small />
      <span v-if="incomingCount && incomingCount > 1" class="seat__incoming-count">{{ incomingCount }}</span>
    </div>
  </section>
</template>


<style scoped>
.seat{min-width:0;position:relative;color:#f5e7d2;font-family:Inter,system-ui,Arial,sans-serif;}
.seat--opponent{
  width:100%;height:100%;min-height:0;
  display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;
  padding:7px 7px 5px;background:#142f27df;
  border:1px solid rgba(220,195,151,.42);border-radius:11px;
  box-shadow:0 4px 8px #06160f38,inset 0 1px #fff4d00a;
  transition:background .18s ease,border-color .18s ease,box-shadow .18s ease,transform .18s ease;
  touch-action:pan-y;
}
.seat--opponent.seat--turn{border-color:#f6d69c;background:#234c37;box-shadow:0 0 0 1px #d3a96795,0 0 17px #e3b16a38;}
.seat--opponent.seat--target{border-color:#b2dfa9;background:#23543c;box-shadow:0 0 0 2px #9cd5ab66;cursor:pointer;}
.seat--opponent.seat--recommended{border-color:#f9d37d;box-shadow:0 0 0 2px #e8bd65cc,0 0 19px #d7b2745e;}
.seat--opponent.seat--exited{opacity:.48;}
.seat__identity{display:flex;align-items:center;justify-content:space-between;gap:3px;min-width:0;min-height:22px;position:relative;}
.seat__avatar{display:none;}
.seat__info{flex:1;min-width:0;}
.seat__name{
  font-size:clamp(10px,2.6vw,12px);font-weight:800;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;
  line-height:1.2;color:#f4e4c8;letter-spacing:-.012em;
}
.seat__meta{font-size:9px;color:#cf9c73;margin-top:2px;}
.seat__penalties{
  flex:none;display:inline-flex;align-items:center;justify-content:center;gap:3px;
  min-width:29px;padding:3px 6px;border:1px solid #997c58a3;border-radius:20px;
  background:#283329;white-space:nowrap;color:#efc895;font-size:10px;font-weight:800;
}
.seat__penalties span{color:#be916b;}
.seat__turn{
  position:absolute;top:-15px;left:50%;transform:translateX(-50%);
  background:#e8c182;border:1px solid #ffe3ad;color:#203122;
  padding:2px 8px;line-height:1.1;font-size:8px;font-weight:900;letter-spacing:.07em;
  border-radius:20px;box-shadow:0 2px 7px #0005;white-space:nowrap;z-index:3;
  animation:turn-glow 2.4s ease-in-out infinite;
}
.seat__opponent-cards{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;gap:6px;}
.seat__hand-badge{
  flex:none;border:1px solid #bc9c6c73;border-radius:8px;padding:3px 4px;
  font-size:10px;background:#0c261bb3;color:#eed4b2;font-weight:700;
}
.seat__pile{position:relative;display:flex;align-items:center;justify-content:center;min-width:44px;height:70px;}
.seat__pile :deep(.playing-card){--width:43px!important;max-width:100%;animation:card-arrival .26s cubic-bezier(.18,.8,.3,1.18);}
.seat__pile-count{
  position:absolute;right:-7px;top:1px;display:grid;place-items:center;
  background:#2b5e4a;border:1px solid #8cbfa4;color:#f2eaca;
  width:19px;height:19px;font-size:10px;border-radius:100%;font-weight:800;box-shadow:0 2px 4px #0005;
}
.seat__pile-empty{width:43px;height:63px;border:1.5px dashed #b3ab8088;border-radius:8px;display:grid;place-items:center;color:#ddc39a;font-size:20px;}
.seat--me{
  display:flex;flex-direction:column;width:100%;height:100%;min-height:0;
  border:0;background:none;padding:0;color:#f7ebd5;
}
.seat--me .seat__identity{width:100%;padding:3px 5px 4px;flex:none;}
.seat--me .seat__name{font-size:12px;max-width:230px;}
.seat--me .seat__penalties{padding:3px 8px;}
.seat--me .seat__turn{top:-12px;left:50%;font-size:8px;}
.seat--me .seat__mine{flex:1;min-height:0;display:flex;flex-direction:column;align-items:stretch;}
.seat__hand-heading{
  flex:none;display:flex;align-items:center;justify-content:space-between;
  padding:1px 6px 3px;min-height:16px;
}
.seat__hand-title{display:flex;gap:6px;align-items:center;font-size:10px;color:#d5be97;font-weight:800;}
.seat__section-label:empty{display:none;}
.seat__hand-count{font-size:10px;font-weight:700;color:#ccb58c;}
.seat__expand-button{
  color:#e8c48c;background:#24543d;border:1px solid #9cba9360;
  border-radius:9px;padding:2px 9px;font-size:10px;cursor:pointer;
}
.seat__deal-area{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 6px 3px;}
.seat__stack{position:relative;width:68px;height:100px;display:block;touch-action:none;}
.seat__stack-layer{position:absolute;inset:0;pointer-events:none;}
.seat__stack-layer--bottom{transform:translate(-8px,1px) rotate(-6deg);}
.seat__stack-layer--middle{transform:translate(-4px,0) rotate(-3deg);}
.seat__stack-layer--top{pointer-events:auto;animation:card-arrival .28s ease-out;}
.seat__stack :deep(.playing-card){--width:63px!important;}
.seat__card-button{background:transparent;border:0;padding:0;margin:0;cursor:pointer;display:block;touch-action:none;}
.seat__stack-button{cursor:grab;}
.seat__stack-button:active{cursor:grabbing;}
.seat__stack-count{
  position:absolute;bottom:0;right:-8px;min-width:23px;height:23px;
  display:grid;place-items:center;border:1px solid #ffdf9c;border-radius:50%;
  background:#ddb77b;color:#172c20;font-size:12px;font-weight:900;box-shadow:0 2px 7px #0006;
  pointer-events:none;
}
.seat__empty-pile{display:grid;place-items:center;border:1px dashed #ceb58c99;border-radius:11px;width:72px;height:92px;color:#d9bf91;font-size:28px;}
.seat__play-area{flex:1;min-height:0;display:flex;align-items:center;gap:10px;overflow:hidden;}
.seat__reserved{flex:none;width:70px;display:flex;flex-direction:column;align-items:center;gap:5px;}
.seat__reserved .seat__section-label{font-size:9px;color:#cfb68a;}
.seat__reserved-cards{display:flex;gap:0;}
.seat__reserved-cards :deep(.playing-card){--width:31px!important;margin-right:-15px;}
.seat__hand-scroll{
  flex:1;min-width:0;min-height:0;display:flex;align-items:center;justify-content:flex-start;
  overflow-x:auto;overflow-y:hidden;gap:0;padding:5px 9px 7px;
  scrollbar-width:thin;scrollbar-color:#a28a60 transparent;
  scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch;touch-action:pan-x;
}
.seat__hand-scroll--expanded{gap:5px;}
.seat__hand-card{position:relative;flex:none;scroll-snap-align:start;margin-right:-11px;transition:transform .16s ease,filter .16s ease;}
.seat__hand-card:active,.seat__hand-card--selected{transform:translateY(-9px);z-index:2;filter:drop-shadow(0 4px 7px #0007);}
.seat__hand-card :deep(.playing-card){--width:65px!important;}
.seat__empty-hand{font-size:11px;color:#cfbc9d;text-align:center;width:100%;}
@media(max-width:390px){
 .seat--opponent{padding:5px 4px 3px;border-radius:9px;}
 .seat__opponent-cards{gap:3px;}
 .seat__pile{min-width:36px;height:58px;}
 .seat__pile :deep(.playing-card){--width:37px!important;}
 .seat__pile-empty{width:36px;height:53px;}
 .seat__name{font-size:10px;}
 .seat__penalties{min-width:26px;padding:2px 5px;font-size:9px;}
 .seat__pile-count{width:17px;height:17px;font-size:9px;}
 .seat__hand-badge{font-size:9px;padding:2px;}
 .seat__stack{height:93px;width:65px;}
 .seat__stack :deep(.playing-card){--width:59px!important;}
 .seat__hand-card :deep(.playing-card){--width:61px!important;}
}
@media(max-height:680px){
 .seat--opponent .seat__opponent-cards{min-height:0;}
 .seat__pile{height:58px;}
 .seat--me .seat__deal-area{padding:0;}
 .seat__stack{height:87px;}
 .seat__stack :deep(.playing-card){--width:56px!important;}
}
@keyframes turn-glow{50%{box-shadow:0 0 11px #e8bc83a0}}
@keyframes card-arrival{from{opacity:.6;transform:translateY(-14px) scale(1.07);}to{opacity:1;transform:translateY(0) scale(1);}}
@media(prefers-reduced-motion:reduce){.seat__turn,.seat__stack-layer--top,.seat__pile :deep(.playing-card){animation:none;}.seat__hand-card{transition:none;}}

/* Cards are the seats; names and penalties are just small labels beside them.
   No cards-in-boxes, placeholder slots or ornate player frames. */
.seat--opponent,.seat--opponent.seat--turn,.seat--opponent.seat--target,.seat--opponent.seat--recommended {
  display:flex;flex-direction:row;justify-content:center;align-items:center;gap:5px;
  padding:3px 2px;background:transparent;border:0;border-radius:0;
  box-shadow:none;outline:0;overflow:visible;
}
.seat--opponent .seat__opponent-cards {flex:0 0 auto;order:0;gap:0;overflow:visible;}
.seat--opponent .seat__identity {
  flex:1;order:1;min-width:0;align-self:center;display:flex;
  flex-direction:column;align-items:flex-start;justify-content:center;gap:3px;
}
.seat--opponent .seat__info{max-width:100%;overflow:hidden;}
.seat--opponent .seat__name{font-size:clamp(9px,2.6vw,12px);text-shadow:0 1px 5px #061b0e;}
.seat--opponent .seat__penalties {
  margin:0;padding:0;border:0;background:transparent;
  color:#e6c18c;font-size:10px;min-width:0;justify-content:flex-start;
}
.seat--opponent .seat__penalties span{color:#b88456;}
.seat--opponent .seat__pile{min-width:0;height:auto;min-height:0;}
.seat--opponent .seat__pile :deep(.playing-card){--width:clamp(31px,9vw,56px)!important;}
.seat--opponent .seat__pile-count{top:0;right:-7px;width:17px;height:17px;font-size:9px;}
.seat--opponent .seat__turn{
  position:absolute;left:50%;top:-9px;transform:translateX(-50%);
  padding:1px 6px;border-radius:10px;font-size:8px;z-index:3;
}
.seat--opponent.seat--target .seat__pile :deep(.playing-card){
  outline:2px solid #97c89e;outline-offset:3px;border-radius:6px;
  box-shadow:0 0 14px #d8ce7470;
}
.seat--opponent.seat--recommended .seat__pile :deep(.playing-card){
  outline:3px solid #f6d08b;outline-offset:3px;border-radius:6px;
  box-shadow:0 0 21px #f4c77783;
}
.seat__pile-empty,.seat__empty-pile {display:none;}
.seat__incoming-card{
  pointer-events:none;position:absolute;z-index:11;
  top:calc(100% - 10px);left:30%;
  transform:translateX(-50%) rotate(-9deg);
  animation:incoming-card-arrival .34s ease-out;
  filter:drop-shadow(0 5px 7px #00160d8f);
}
.seat__incoming-card :deep(.playing-card){--width:clamp(33px,7vw,62px)!important;}
.seat__incoming-card--mine{top:-57px;left:50%;transform:translateX(-50%) rotate(6deg);}
.seat__incoming-count{
  position:absolute;right:-9px;top:-5px;border:1px solid #e9cc90;
  background:#254938;color:#f5dfad;min-width:16px;height:17px;
  border-radius:50%;display:grid;place-items:center;font-size:9px;font-weight:900;
}
@keyframes incoming-card-arrival{
  from{opacity:0;translate:0 -23px;scale:.82;}
  to{opacity:1;translate:0 0;scale:1;}
}
@media(max-width:430px){
 .seat--opponent{gap:4px!important;}
 .seat--opponent .seat__name{font-size:clamp(8px,2.7vw,10px)!important;}
 .seat--opponent .seat__pile :deep(.playing-card){--width:clamp(30px,9vw,41px)!important;}
 .seat__incoming-card :deep(.playing-card){--width:32px!important;}
 .seat__incoming-card--mine :deep(.playing-card){--width:43px!important;}
}
@media(prefers-reduced-motion:reduce){.seat__incoming-card{animation:none;}}


/* A flying card exists once: conceal its on-seat counterpart until landing. */
.seat__pile--moving :deep(.playing-card),
.seat__stack-layer--moving :deep(.playing-card){
  opacity:0!important;
}
.seat--aimed .seat__pile :deep(.playing-card),
.seat--aimed .seat__stack :deep(.playing-card) {
  filter:drop-shadow(0 0 12px rgba(252,217,143,.82));
  transform:translateY(-3px);
  transition:filter .12s ease,transform .12s ease;
}
.seat--aimed .seat__name { color:#ffe6b0; }
@media(prefers-reduced-motion:reduce) {
  .seat--aimed .seat__pile :deep(.playing-card),
  .seat--aimed .seat__stack :deep(.playing-card){transition:none;transform:none;}
}


/* P1 — Hand is the primary control, not a boxed horizontal strip. */
.seat--me .seat__play-area--fan {
  overflow:visible;position:relative;width:100%;height:100%;
  justify-content:center;align-items:stretch;
}
.seat--me .seat__play-area--fan > .hand-fan{min-width:0;flex:1;}
.seat--me .seat__reserved{
  position:absolute;z-index:2;left:3px;top:5px;
  width:auto;max-width:50px;
  align-items:flex-start;opacity:.76;pointer-events:none;
}
.seat--me .seat__reserved-cards :deep(.playing-card) {--width:26px!important;}
.seat--me .seat__reserved-cards {max-width:50px;}
.seat--me .seat__mine{overflow:visible;}
.seat--me .seat__identity{flex:0 0 auto;justify-content:center;gap:12px;}
.seat--me .seat__info{flex:0 1 auto;}
.seat--me .seat__penalties{font-size:12px;color:#f0ca93;}
@media(max-width:430px) {
 .seat--me .seat__reserved{left:0;top:1px;}
 .seat--me .seat__reserved-cards :deep(.playing-card){--width:22px!important;}
}

</style>
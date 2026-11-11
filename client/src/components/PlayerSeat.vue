<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Player, Card } from '@shared/types';
import CardComponent from './CardComponent.vue';

const props = defineProps<{
  player: Player;
  isMe: boolean;
  isTurn: boolean;
  phase: string;
  selectedCardId?: string | null;
  targetable?: boolean;
}>();
const emit = defineEmits<{
  cardClick: [payload: { card: Card; ownerId: string }];
  click: [];
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
          <span v-if="isMe" class="seat__you">ВЫ</span>
          <span v-if="player.isBot" class="seat__bot">БОТ</span>
        </div>
        <div class="seat__meta">
          <span v-if="player.hasExited" class="seat__exited-label">Вышел из игры</span>
          <span v-else-if="player.onDuty" class="seat__duty">На вахте</span>
          <span v-else>{{ player.hand.length }} в руке · {{ player.stumps.length }} пеньки</span>
        </div>
      </div>
      <div v-if="player.penalties" class="seat__penalties" :title="'Штрафы: ' + player.penalties">
        <span>!</span> {{ player.penalties }}
      </div>
      <span v-if="isTurn" class="seat__turn">ХОД</span>
    </div>

    <template v-if="!isMe">
      <div class="seat__opponent-cards">
        <div class="seat__backs" aria-hidden="true">
          <CardComponent v-for="n in Math.min(player.hand.length, 3)" :key="n" hidden small />
          <span v-if="player.hand.length > 3" class="seat__count">+{{ player.hand.length - 3 }}</span>
        </div>
        <div v-if="player.stumps.length" class="seat__pile">
          <CardComponent
            :card="['DEALING','PENALTY_REVIEW'].includes(phase) && player.stumps.length >= 3 ? player.stumps[player.stumps.length - 1] : undefined"
            :hidden="!['DEALING','PENALTY_REVIEW'].includes(phase) || player.stumps.length < 3"
            small
          />
          <span class="seat__pile-count">{{ player.stumps.length }}</span>
        </div>
      </div>
      <div v-if="targetable && !player.hasExited" class="seat__target-hint">Нажми, чтобы передать карту</div>
    </template>

    <template v-else>
      <div class="seat__mine">
        <div class="seat__hand-heading">
          <div class="seat__hand-title">
            <span class="seat__section-label">{{ ['DEALING','PENALTY_REVIEW'].includes(phase) ? 'ВАША СТОПКА' : 'ВАШИ КАРТЫ' }}</span>
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
          <div class="seat__deal-info">
            <strong>Собираем стопку</strong>
            <span>Нижние карты скрыты. Видна только верхняя карта.</span>
            <span v-if="player.stumps.length > 3">Можно передать верхнюю карту сопернику, если она бьёт его карту.</span>
          </div>
          <div class="seat__stack" :aria-label="'Стопка из ' + player.stumps.length + ' карт'">
            <div class="seat__stack-layer seat__stack-layer--bottom"><CardComponent hidden /></div>
            <div v-if="player.stumps.length > 1" class="seat__stack-layer seat__stack-layer--middle"><CardComponent hidden /></div>
            <div :key="player.stumps[player.stumps.length - 1]?.id" class="seat__stack-layer seat__stack-layer--top">
              <button
                v-if="player.stumps.length > 3"
                type="button"
                class="seat__card-button seat__stack-button"
                :aria-label="'Передать верхнюю карту ' + player.stumps[player.stumps.length - 1]?.rank + ' ' + player.stumps[player.stumps.length - 1]?.suit"
                @click.stop="selectCard(player.stumps[player.stumps.length - 1]!)"
              ><CardComponent :card="player.stumps[player.stumps.length - 1]" /></button>
              <CardComponent v-else :card="player.stumps[player.stumps.length - 1]" />
            </div>
            <span class="seat__stack-count">{{ player.stumps.length }}</span>
          </div>
        </div>

        <div v-else class="seat__play-area">
          <div class="seat__reserved">
            <span class="seat__section-label">ПЕНЬКИ · {{ player.stumps.length }}</span>
            <div class="seat__reserved-cards">
              <CardComponent v-if="player.stumps.length > 1" hidden small />
              <CardComponent v-if="player.stumps.length" hidden small />
            </div>
          </div>
          <div
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
  </section>
</template>

<style scoped>
.seat {
  position: relative;
  min-width: 0;
  border-radius: 17px;
  border: 1px solid rgba(234,223,191,.15);
  background: rgba(12, 32, 31, .76);
  box-shadow: inset 0 1px rgba(255,255,255,.045), 0 8px 25px rgba(0,0,0,.12);
  color: #f6f3eb;
}
.seat--opponent { width: clamp(112px, 17vw, 196px); padding: 10px; flex: 0 0 auto; }
 .seat--me {
  width: min(100%, 1400px);
  padding: 12px 18px 14px;
  border-color: rgba(212,176,98,.36);
  background: linear-gradient(180deg, rgba(24,54,45,.97), rgba(12,31,29,.98));
}
.seat--turn { border-color: #e5bb68; box-shadow: 0 0 0 2px rgba(235,194,107,.20), 0 8px 25px rgba(0,0,0,.16); }
.seat--target { cursor: pointer; border-color: rgba(244,199,112,.7); background: rgba(76,60,33,.78); }
.seat--target:hover, .seat--target:focus-visible { outline: 2px solid #eac782; outline-offset: 2px; }
.seat--exited { opacity: .54; }
.seat__identity { display: flex; align-items: center; gap: 9px; min-width: 0; }
.seat__avatar { width: 32px; height: 32px; flex: none; border-radius: 11px; display: grid; place-items: center; font-size: 13px; font-weight: 900; background: #325448; color: #f6d897; border: 1px solid rgba(248,215,143,.15); }
.seat--me .seat__avatar { width: 36px; height: 36px; }
.seat__info { min-width: 0; flex: 1; }
.seat__name { font-size: 12px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.seat--me .seat__name { font-size: 14px; }
.seat__you { margin-left: 3px; font-size: 9px; color: #e8c27c; letter-spacing: .08em; }
.seat__meta { margin-top: 2px; font-size: 10px; color: #a5b8ad; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.seat__penalties { display: inline-flex; align-items: center; gap: 3px; padding: 3px 5px; border: 1px solid rgba(239,116,100,.4); border-radius: 6px; background: rgba(128,43,42,.45); color: #ffd5ca; font-weight: 900; font-size: 10px; }
.seat__turn { position: absolute; right: 10px; top: -10px; color: #19291f; background: #e9bd6a; border-radius: 99px; padding: 3px 9px; font-weight: 900; font-size: 9px; letter-spacing: .11em; box-shadow: 0 4px 10px rgba(0,0,0,.2); }
.seat__duty { color: #e7be79; }
.seat__exited-label { color: #96d9bd; }
.seat__opponent-cards { min-height: 56px; display: flex; align-items: center; justify-content: space-around; margin-top: 9px; gap: 4px; }
.seat__backs { position: relative; display: flex; align-items: center; min-width: 0; padding-right: 10px; }
.seat__backs :deep(.playing-card:not(:first-child)) { margin-left: -29px; }
.seat__count { position: absolute; right: -8px; bottom: -6px; padding: 2px 6px; background: #d4ae70; color: #253627; border-radius: 99px; font-size: 10px; font-weight: 900; }
.seat__pile { position: relative; }
.seat__pile-count { position: absolute; right: -5px; top: -4px; padding: 2px 5px; background: #234636; border-radius: 6px; font-size: 9px; }
.seat__target-hint { margin-top: 9px; font-size: 10px; text-align: center; color: #f4d6a0; }
.seat__mine { min-width: 0; }
.seat__section-label { color: #93b9a5; letter-spacing: .11em; font-size: 10px; font-weight: 800; }
.seat__stumps-row { display: flex; gap: 10px; align-items: center; margin-top: 8px; min-height: 38px; }
.seat__stumps { display: flex; align-items: center; padding-left: 2px; }
.seat__stump:not(:first-child) { margin-left: -22px; }
.seat__stumps :deep(.playing-card) { --width: 39px; }
.seat__card-button { padding: 0; border: 0; color: inherit; background: transparent; cursor: pointer; display: block; border-radius: 9px; touch-action: manipulation; }
.seat__card-button:focus-visible { outline: 3px solid #ffd18a; outline-offset: 3px; }
.seat__hand-heading { display: flex; justify-content: space-between; gap: 12px; margin-top: 7px; }
.seat__hand-count { font-size: 10px; color: #e4c489; font-weight: 700; }
.seat__hand-scroll { display: flex; align-items: flex-end; gap: 6px; min-height: 66px; overflow-x: auto; overflow-y: hidden; padding: 7px 4px 6px; scroll-snap-type: x proximity; scrollbar-width: thin; scrollbar-color: #6a8c70 transparent; }
.seat__empty-hand { padding: 19px 12px; font-size: 12px; color: #91ae9e; }
.seat__hand-card { flex: none; scroll-snap-align: start; transition: transform .15s ease, filter .15s ease; }
.seat__hand-card:hover, .seat__hand-card--selected { transform: translateY(-7px); filter: drop-shadow(0 0 8px rgba(245,214,142,.3)); }
.seat__hand-card--selected :deep(.playing-card) { outline: 3px solid #edc37f; outline-offset: 2px; }
@media (max-width: 700px) {
  .seat--opponent { width: 112px; padding: 7px; border-radius: 12px; }
  .seat--opponent .seat__avatar { width: 25px; height: 25px; border-radius: 8px; }
  .seat--opponent .seat__identity { gap: 5px; }
  .seat--opponent .seat__name { font-size: 11px; }
  .seat--opponent .seat__meta { font-size: 9px; }
  .seat__opponent-cards { min-height: 35px; margin-top: 4px; }
  .seat--opponent :deep(.playing-card) { --width: 29px; }
  .seat__backs :deep(.playing-card:not(:first-child)) { margin-left: -18px; }
  .seat__count { font-size: 9px; }
  .seat--me { padding: 10px 12px 8px; border-radius: 14px; }
  .seat__hand-scroll { min-height: 65px; }
  .seat__stumps-row { margin-top: 4px; }
  .seat__hand-card:hover { transform: none; }
  .seat__hand-card--selected { transform: translateY(-6px); }
}
@media (prefers-reduced-motion: reduce) { .seat__hand-card { transition: none; } }
.seat__bot { margin-left: 4px; border: 1px solid #d4b977; border-radius: 5px; padding: 1px 4px; color: #efcc8c; font-size: 9px; letter-spacing: .04em; font-weight: 900; }

/* Deal: show one face-up card only; the pile conceals all lower faces. */
.seat__hand-heading { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:10px; margin-bottom:8px; }
.seat__hand-title { display:flex; align-items:center; flex-wrap:wrap; gap:14px; }
.seat__hand-title .seat__section-label { color:#ead09b; font-size:12px; }
.seat__hand-count { font-size:12px; color:#abcbb9; font-weight:800; }
.seat__expand-button { flex:none; border:1px solid #c6a165; background:rgba(219,179,108,.12); color:#efdbb9; padding:9px 16px; min-height:38px; border-radius:10px; font-size:12px; font-weight:900; cursor:pointer; touch-action:manipulation; }
.seat__expand-button:hover, .seat__expand-button:focus-visible { background:rgba(221,181,109,.24); outline-color:#f3d49c; }
.seat__expand-button span { margin-left:6px; }
.seat__deal-area { min-height:165px; display:flex; align-items:center; justify-content:center; gap:clamp(22px,4vw,55px); border:1px dashed rgba(214,188,128,.18); border-radius:14px; background: radial-gradient(ellipse at center,rgba(49,91,69,.2),rgba(8,28,26,.1)); padding:14px 20px; }
.seat__deal-info { display:flex; flex-direction:column; max-width:400px; gap:7px; font-size:12px; line-height:1.45; color:#a7c7b4; }
.seat__deal-info strong { color:#e5c184; font-size:15px; }
.seat__stack { width:90px; height:133px; flex:none; position:relative; filter:drop-shadow(0 9px 12px rgba(0,0,0,.3)); }
.seat__stack-layer { position:absolute; top:0; left:0; }
.seat__stack-layer--bottom { transform: translate(-7px,6px) rotate(-5deg); }
.seat__stack-layer--middle { transform: translate(-3px,2px) rotate(-2deg); }
.seat__stack-layer--top { transform:translate(3px,-3px) rotate(2deg); z-index:1; animation:pile-card-entry .23s ease-out; }
.seat__stack-layer--top :deep(.playing-card) { --width:82px; }
.seat__stack-layer--bottom :deep(.playing-card), .seat__stack-layer--middle :deep(.playing-card) { --width:82px; }
.seat__stack-count { position:absolute; bottom:-5px; right:-8px; padding:3px 9px; background:#e6bf78; color:#23382e; font-weight:900; font-size:13px; border-radius:99px; z-index:3; border:2px solid #163a32; }
.seat__stack-button { display:block; }
@keyframes pile-card-entry { from { transform:translate(-34px,-42px) rotate(-15deg) scale(.88); opacity:.25; } to {transform:translate(3px,-3px) rotate(2deg); opacity:1;} }
.seat__play-area { display:grid; grid-template-columns:94px minmax(0,1fr); gap:18px; min-height:170px; align-items:stretch; }
.seat__reserved { display:flex; flex-direction:column; gap:15px; padding:8px 12px 10px 4px; border-right:1px solid rgba(216,196,145,.17); }
.seat__reserved-cards { display:flex; align-items:flex-start; }
.seat__reserved-cards :deep(.playing-card:not(:first-child)) { margin-left:-28px; transform:rotate(5deg); }
.seat__hand-scroll { min-width:0; min-height:158px; height:158px; display:flex; align-items:center; gap:10px; overflow-x:auto; overflow-y:hidden; padding:14px 9px; scroll-snap-type:x proximity; scrollbar-width:thin; scrollbar-color:#a78d65 transparent; }
.seat__hand-scroll--expanded { height:auto; max-height:min(39dvh,390px); min-height:215px; flex-wrap:wrap; justify-content:flex-start; align-content:flex-start; align-items:flex-start; gap:12px; overflow-x:hidden; overflow-y:auto; scroll-snap-type:none; padding:17px; background:rgba(18,48,41,.45); border-radius:13px; box-shadow:inset 0 0 0 1px rgba(209,192,149,.14); }
.seat__hand-scroll--expanded .seat__hand-card { animation: card-reveal .22s ease-out both; }
@keyframes card-reveal { from { opacity:.4; transform:translateY(13px); } to { opacity:1; transform:translateY(0); } }
.seat__hand-card { flex:none; }
@media (max-width:700px) {
  .seat__deal-area { min-height:128px; padding:8px 10px; gap:18px; }
  .seat__deal-info { font-size:11px; line-height:1.4; }
  .seat__deal-info strong { font-size:13px; }
  .seat__stack { width:75px; height:110px; }
  .seat__stack-layer :deep(.playing-card) { --width:67px !important; }
  .seat__stack-count { right:0; bottom:0; }
  .seat__play-area { grid-template-columns:55px minmax(0,1fr); gap:7px; min-height:137px; }
  .seat__reserved { padding:8px 4px 8px 0; }
  .seat__reserved .seat__section-label { font-size:8px; letter-spacing:0; }
  .seat__reserved-cards :deep(.playing-card) { --width:32px; }
  .seat__reserved-cards :deep(.playing-card:not(:first-child)) { margin-left:-21px; }
  .seat__hand-scroll { height:137px; min-height:137px; padding:10px 3px; gap:7px; }
  .seat__hand-scroll--expanded { height:auto; min-height:230px; max-height:42dvh; gap:8px; padding:9px; }
  .seat__hand-scroll--expanded :deep(.playing-card) { --width:65px; }
  .seat__expand-button { min-height:34px; padding:7px 11px; font-size:11px; }
  .seat__hand-title { gap:7px; }
  .seat__hand-title .seat__section-label { font-size:10px; }
}
@media (max-width:370px) {
  .seat__deal-info span:last-child { display:none; }
  .seat__deal-area { gap:8px; }
  .seat__hand-scroll--expanded :deep(.playing-card) { --width:59px; }
}
@media (prefers-reduced-motion:reduce) { .seat__stack-layer--top, .seat__hand-scroll--expanded .seat__hand-card { animation:none; } }


.seat--target { animation:seat-target-pulse 1.45s ease-in-out infinite; }
@keyframes seat-target-pulse { 0%,100% { box-shadow:0 0 0 1px rgba(237,197,124,.25),0 7px 20px #0005; } 50% { box-shadow:0 0 0 4px rgba(255,209,120,.52),0 7px 23px #0007; } }
.seat--turn .seat__avatar { box-shadow:0 0 0 2px #e4c282,0 0 15px #eac4815a; }
.seat__hand-card { animation:card-appear .26s ease-out backwards; }
@keyframes card-appear { from { opacity:.25; filter:blur(2px); } to { opacity:1; filter:blur(0); } }
@media (prefers-reduced-motion:reduce) { .seat--target,.seat__hand-card {animation:none;} }

</style>
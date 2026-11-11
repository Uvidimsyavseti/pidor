<script setup lang="ts">
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
            :card="phase === 'DEALING' && player.stumps.length >= 3 ? player.stumps[player.stumps.length - 1] : undefined"
            :hidden="phase !== 'DEALING' || player.stumps.length < 3"
            small
          />
          <span class="seat__pile-count">{{ player.stumps.length }}</span>
        </div>
      </div>
      <div v-if="targetable && !player.hasExited" class="seat__target-hint">Нажми, чтобы передать карту</div>
    </template>

    <template v-else>
      <div class="seat__mine">
        <div class="seat__stumps-row">
          <span class="seat__section-label">ПЕНЬКИ</span>
          <div class="seat__stumps">
            <div v-for="(card, i) in player.stumps" :key="'stump-' + i" class="seat__stump">
              <button
                v-if="i === player.stumps.length - 1 && i >= 3 && phase === 'DEALING'"
                class="seat__card-button"
                type="button"
                :aria-label="'Передать карту ' + card.rank + ' ' + card.suit"
                @click.stop="selectCard(card)"
              ><CardComponent :card="card" small /></button>
              <CardComponent v-else :hidden="i < 2 || phase !== 'DEALING'" :card="card" small />
            </div>
          </div>
        </div>

        <div class="seat__hand-heading">
          <span class="seat__section-label">ВАШИ КАРТЫ</span>
          <span class="seat__hand-count">{{ player.hand.length }} шт.</span>
        </div>
        <div class="seat__hand-scroll" data-testid="my-hand">
          <div v-if="!player.hand.length" class="seat__empty-hand">
            {{ phase === 'DEALING' ? 'Карты появятся после набора' : 'В руке пока нет карт' }}
          </div>
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
  width: min(100%, 980px);
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
</style>
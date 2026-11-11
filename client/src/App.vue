<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useGameStore } from './stores/game';
import PlayerSeat from './components/PlayerSeat.vue';
import CardComponent from './components/CardComponent.vue';
import type { Card } from '@shared/types';

interface TelegramWebApp {
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  openTelegramLink?: (url: string) => void;
  onEvent?: (event: string, callback: () => void) => void;
  viewportStableHeight?: number;
  HapticFeedback?: { impactOccurred?: (style: string) => void };
  initDataUnsafe?: {
    user?: { first_name?: string; username?: string };
    start_param?: string;
  };
}
const tg = (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
const gameStore = useGameStore();
const name = ref('');
const room = ref(new URLSearchParams(window.location.search).get('room') || 'pidor-1');
const selectedCard = ref<Card | null>(null);
const copied = ref(false);
const showRules = ref(false);

onMounted(() => {
  tg?.ready?.();
  tg?.expand?.();
  tg?.setHeaderColor?.('#0b1718');
  tg?.setBackgroundColor?.('#0b1718');
  const syncViewport = () => {
    if (tg?.viewportStableHeight) {
      document.documentElement.style.setProperty('--tg-height', tg.viewportStableHeight + 'px');
    }
  };
  syncViewport();
  tg?.onEvent?.('viewportChanged', syncViewport);
  if (tg?.initDataUnsafe?.user) {
    name.value = tg.initDataUnsafe.user.first_name || tg.initDataUnsafe.user.username || '';
  }
  if (tg?.initDataUnsafe?.start_param?.startsWith('room_')) {
    room.value = tg.initDataUnsafe.start_param.slice(5);
  }
});
watch(() => gameStore.gameState?.phase, () => { selectedCard.value = null; });

const state = computed(() => gameStore.gameState);
const me = computed(() => state.value?.players.find(p => p.id === gameStore.playerId));
const others = computed(() => {
  if (!state.value) return [];
  const idx = state.value.players.findIndex(p => p.id === gameStore.playerId);
  if (idx < 0) return state.value.players;
  return [...state.value.players.slice(idx + 1), ...state.value.players.slice(0, idx)];
});
const isMyTurn = computed(() => state.value?.players[state.value.turnIndex]?.id === gameStore.playerId);
const turnPlayer = computed(() => state.value?.players[state.value.turnIndex]);
const phaseLabel = computed(() => ({
  LOBBY: 'Лобби', DEALING: 'Набор карт',
  PENALTY_DISTRIBUTION: 'Штрафные карты', MAIN_GAME: 'Основная игра',
  ENDED: 'Конец партии'
})[state.value?.phase || 'LOBBY']);
const trumpSymbol = computed(() => {
  const names: Record<string, string> = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
  return names[state.value?.trumpSuit || ''] || '—';
});
const trumpIsRed = computed(() => ['hearts','diamonds'].includes(state.value?.trumpSuit || ''));
const canDraw = computed(() => state.value?.phase === 'DEALING' && isMyTurn.value && !state.value?.activeCard && !!state.value?.deck.length);
const canTakeStumps = computed(() => state.value?.phase === 'MAIN_GAME' && me.value?.hand.length === 0 && !!me.value.stumps.length && state.value?.currentTrick.length === 0);
const canExitGame = computed(() => state.value?.phase === 'MAIN_GAME' && me.value?.hand.length === 0 && me.value?.stumps.length === 0 && state.value?.currentTrick.length === 0 && !me.value.hasExited);
const targeting = computed(() => state.value?.phase === 'DEALING' && isMyTurn.value && !!state.value?.activeCard);
const penaltyTargets = computed(() => others.value.filter(p => (state.value?.pendingPenaltyDebts?.[p.id]?.[gameStore.playerId] || 0) > 0));
const penaltyTargeting = computed(() => state.value?.phase === 'PENALTY_DISTRIBUTION' && selectedCard.value !== null && penaltyTargets.value.length > 0);
const guidance = computed(() => {
  if (!state.value) return '';
  if (state.value.phase === 'DEALING') {
    if (targeting.value) return 'Выберите игрока, которому положить карту. Если побить некого — себе.';
    if (isMyTurn.value) return 'Проверьте верхнюю карту своей стопки или вытяните карту из колоды.';
    return 'Сейчас ходит ' + (turnPlayer.value?.name || 'другой игрок') + '.';
  }
  if (state.value.phase === 'PENALTY_DISTRIBUTION') {
    if (!penaltyTargets.value.length) return 'Твои штрафные карты розданы. Ожидаем остальных игроков.';
    return selectedCard.value
      ? 'Передайте выбранную карту игроку, которому вы должны штраф.'
      : 'Выберите карту из руки. Штраф нужно передать отмеченным игрокам.';
  }
  if (state.value.phase === 'MAIN_GAME') {
    if (canTakeStumps.value) return 'Основные карты закончились — пора взять пеньки.';
    if (canExitGame.value) return 'Все карты вышли. Можно закончить игру.';
    if (isMyTurn.value) return 'Побейте верхнюю карту той же мастью или козырем. Можно забрать нижнюю.';
    return 'Ход игрока ' + (turnPlayer.value?.name || '…');
  }
  if (state.value.phase === 'ENDED') return 'Партия завершена. Чтобы сыграть ещё, откройте новую комнату.';
  return 'Соберите компанию: для начала нужны хотя бы двое.';
});
const loser = computed(() => state.value?.players.find(p => !p.hasExited));

function haptic() { tg?.HapticFeedback?.impactOccurred?.('light'); }
function join() {
  haptic();
  if (!name.value.trim()) { gameStore.error = 'Введите имя игрока'; return; }
  gameStore.joinRoom(name.value.trim(), room.value.trim());
}
function handleCardClick({ card, ownerId }: { card: Card; ownerId: string }) {
  if (!state.value) return;
  haptic();
  if (state.value.phase === 'DEALING') {
    if (state.value.activeCard && isMyTurn.value) gameStore.placeActiveCard(ownerId);
    else if (ownerId === gameStore.playerId && isMyTurn.value) gameStore.takeFromPile(card.id);
  } else if (state.value.phase === 'MAIN_GAME') {
    if (isMyTurn.value) gameStore.playCard(card.id);
  } else if (state.value.phase === 'PENALTY_DISTRIBUTION' && ownerId === gameStore.playerId) {
    selectedCard.value = selectedCard.value?.id === card.id ? null : card;
  }
}
function handleSeatClick(playerId: string) {
  haptic();
  if (targeting.value) gameStore.placeActiveCard(playerId);
  else if (penaltyTargeting.value && selectedCard.value && penaltyTargets.value.some(p => p.id === playerId)) {
    gameStore.givePenaltyCard(selectedCard.value.id, playerId);
    selectedCard.value = null;
  }
}
function drawCard() {
  if (canDraw.value) { haptic(); gameStore.drawCardFromDeck(); }
}
async function invite() {
  haptic();
  const link = new URL(window.location.href);
  link.searchParams.set('room', gameStore.joined ? gameStore.roomId : room.value.trim());
  const bot = (import.meta.env.VITE_TELEGRAM_BOT_USERNAME as string | undefined)?.replace(/^@/, '');
  if (tg && bot) {
    tg.openTelegramLink?.('https://t.me/' + bot + '?startapp=room_' + encodeURIComponent(gameStore.roomId));
    return;
  }
  try {
    if (navigator.share && !tg) {
      await navigator.share({ title: 'PIDOR — приглашение', text: 'Присоединяйся к игре!', url: link.toString() });
    } else {
      await navigator.clipboard.writeText(link.toString());
      copied.value = true;
      setTimeout(() => { copied.value = false; }, 2500);
    }
  } catch {
    window.prompt('Скопируй ссылку на комнату', link.toString());
  }
}
function newGame() {
  room.value = 'pidor-' + Math.random().toString(36).slice(2, 8);
  gameStore.joinRoom(gameStore.playerName || name.value, room.value);
}
</script>

<template>
  <div class="app-shell">
    <div class="ambient ambient--top"></div>
    <div class="ambient ambient--bottom"></div>

    <template v-if="!gameStore.joined">
      <header class="site-header">
        <div class="brand"><span class="brand__mark">P</span><span>PIDOR<span class="brand__dot">.</span></span></div>
        <span class="site-header__label">Карточная игра · Онлайн</span>
      </header>
      <main class="landing">
        <div class="landing__intro">
          <div class="eyebrow"><span class="eyebrow__line"></span> КАРТОЧНАЯ ИГРА ДЛЯ СВОИХ</div>
          <h1>Собери друзей.<br/><em>Забери вахту.</em></h1>
          <p>36 карт, одна колода и немного удачи. Играй в браузере, с телефона или через Telegram.</p>
          <div class="landing__suits" aria-hidden="true"><span>♠</span><span>♥</span><span>♣</span><span>♦</span></div>
        </div>
        <form class="join-panel" @submit.prevent="join">
          <div class="join-panel__top">
            <div class="eyebrow">БЫСТРЫЙ СТАРТ</div>
            <h2>Заходи за стол</h2>
            <p>Представься и выбери комнату. Друзья смогут присоединиться по той же ссылке.</p>
          </div>
          <label class="field"><span>ВАШЕ ИМЯ</span><input v-model="name" maxlength="32" autocomplete="nickname" placeholder="Как тебя зовут?" /></label>
          <label class="field"><span>НАЗВАНИЕ КОМНАТЫ</span><input v-model="room" maxlength="48" autocomplete="off" spellcheck="false" placeholder="pidor-1" /></label>
          <div v-if="gameStore.error" class="message message--error" role="alert">{{ gameStore.error }}</div>
          <button type="submit" class="main-button" :disabled="gameStore.connecting">
            {{ gameStore.connecting ? 'ПОДКЛЮЧАЕМСЯ…' : 'ИГРАТЬ' }} <span aria-hidden="true">↗</span>
          </button>
          <div class="join-panel__bottom"><span class="status-light"></span> Работает без установки · 2–6 игроков</div>
        </form>
      </main>
      <footer class="landing-footer">PIDOR · ИГРАЙ ПО ПРАВИЛАМ, ЕСЛИ СМОЖЕШЬ</footer>
    </template>

    <template v-else-if="state">
      <header class="site-header site-header--game">
        <div class="brand"><span class="brand__mark">P</span><span>PIDOR<span class="brand__dot">.</span></span></div>
        <div class="header-room">
          <span>КОМНАТА</span>
          <strong>{{ gameStore.roomId }}</strong>
        </div>
        <div class="header-actions">
          <div class="connection" :class="{ 'connection--off': !gameStore.connected }">
            <span class="status-light"></span>
            <span>{{ gameStore.connected ? 'В СЕТИ' : 'НЕТ СВЯЗИ' }}</span>
          </div>
          <button class="subtle-button" type="button" @click="showRules = !showRules">{{ showRules ? 'Закрыть' : 'Правила' }}</button>
          <button class="outline-button" type="button" @click="invite">{{ copied ? 'Скопировано ✓' : 'Пригласить ↗' }}</button>
        </div>
      </header>

      <div v-if="!gameStore.connected || gameStore.error" class="connection-alert" role="status">
        {{ gameStore.error || 'Ожидание подключения к серверу…' }}
      </div>
      <Transition name="toast">
        <div v-if="gameStore.lastPenalty" class="penalty-toast" role="alert">
          <strong>ШТРАФ!</strong>
          <span>{{ state.players.find(p => p.id === gameStore.lastPenalty?.playerId)?.name }} · {{ gameStore.lastPenalty.reason }}</span>
        </div>
      </Transition>

      <div v-if="showRules" class="rules-sheet">
        <div class="rules-sheet__header"><strong>Кратко о правилах</strong><button type="button" @click="showRules = false" aria-label="Закрыть правила">✕</button></div>
        <p><b>01 · Набор.</b> Тяните карту по очереди. Карту старше открытой кладите на первую подходящую стопку по кругу. Шестёрка бьёт туза. Последнюю карту колоды оставьте себе.</p>
        <p><b>02 · Штрафы.</b> За нарушения игроки получают «хуёвые» — дополнительные карты от остальных. Последнюю карту из руки отдавать нельзя.</p>
        <p><b>03 · Игра.</b> Бейте старшую карту той же масти или козырем, но пику — только пикой. Не можете побить — берите нижнюю. Когда закончится рука, берите пеньки; когда закончатся и они — выходите.</p>
        <button class="outline-button" type="button" @click="showRules = false">ПОНЯТНО</button>
      </div>

      <main v-if="state.phase === 'LOBBY'" class="lobby">
        <div class="lobby__heading"><span class="eyebrow">КОМНАТА ГОТОВА</span><h1>Ожидаем игроков</h1><p>Поделись ссылкой и собери компанию. Начать можно вдвоём.</p></div>
        <div class="lobby__panel">
          <div class="lobby__top"><span>УЧАСТНИКИ</span><strong>{{ state.players.length }} / 6</strong></div>
          <div class="lobby__players">
            <div v-for="p in state.players" :key="p.id" class="lobby-person">
              <div class="lobby-person__avatar">{{ p.name.slice(0, 1).toUpperCase() }}</div>
              <div class="lobby-person__name">{{ p.name }} <span v-if="p.id === gameStore.playerId">· ВЫ</span></div>
            </div>
            <div v-for="n in Math.max(2 - state.players.length, 0)" :key="'empty-' + n" class="lobby-person lobby-person--empty">
              <div class="lobby-person__avatar">+</div><span>Свободное место</span>
            </div>
          </div>
          <button v-if="state.players.length >= 2" class="main-button" type="button" @click="gameStore.startGame()">ПОЕХАЛИ <span>→</span></button>
          <button v-else class="main-button main-button--secondary" type="button" @click="invite()">ПРИГЛАСИТЬ ДРУГА <span>↗</span></button>
          <p class="lobby__notice">{{ state.players.length >= 2 ? 'Всё готово! Можно начинать партию.' : 'Нужен ещё хотя бы один игрок для старта.' }}</p>
        </div>
      </main>

      <main v-else class="game-layout">
        <div class="game-status">
          <div class="game-status__phase"><span class="phase-symbol">✦</span><span>{{ phaseLabel }}</span></div>
          <p>{{ guidance }}</p>
          <span v-if="isMyTurn && state.phase !== 'ENDED'" class="your-turn">ВАШ ХОД</span>
          <span v-else-if="turnPlayer && state.phase !== 'ENDED'" class="whose-turn">Ход: {{ turnPlayer.name }}</span>
        </div>
        <div class="table-surface">
          <div class="table-surface__ring" aria-hidden="true"></div>
          <div class="opponents">
            <PlayerSeat
              v-for="p in others" :key="p.id"
              :player="p" :is-me="false"
              :phase="state.phase"
              :is-turn="turnPlayer?.id === p.id"
              :targetable="(targeting || (penaltyTargeting && penaltyTargets.some(target => target.id === p.id))) && !p.hasExited"
              @click="handleSeatClick(p.id)" @card-click="handleCardClick"
            />
          </div>

          <div class="table-center">
            <div class="table-center__label">ИГРОВОЙ СТОЛ</div>
            <div class="table-center__cards">
              <div class="table-center__slot">
                <span class="slot-heading">КОЛОДА</span>
                <button
                  type="button" class="deck-button" :class="{ 'deck-button--available': canDraw }"
                  :disabled="!canDraw" aria-label="Вытянуть карту из колоды"
                  @click="drawCard"
                >
                  <CardComponent v-if="state.deck.length" hidden />
                  <div v-else class="empty-slot">0</div>
                </button>
                <span class="slot-count">{{ state.deck.length }} карт</span>
              </div>

              <div class="table-center__slot table-center__slot--trick">
                <span class="slot-heading">СТОЛ</span>
                <div class="trick-stack">
                  <div v-if="!state.currentTrick.length" class="empty-slot empty-slot--trick"><span>✧</span></div>
                  <CardComponent
                    v-for="(card, i) in state.currentTrick" :key="card.id"
                    :card="card" class="trick-card"
                    :style="{ transform: 'translateX(' + (i - (state.currentTrick.length - 1) / 2) * 12 + 'px) rotate(' + (i % 2 ? 6 : -5) + 'deg)' }"
                  />
                  <div v-if="state.activeCard" class="active-card" :class="{ 'active-card--hidden': state.activeCard.card.id.startsWith('masked-') }">
                    <CardComponent :card="state.activeCard.card" :hidden="state.activeCard.card.id.startsWith('masked-')" />
                  </div>
                </div>
                <span class="slot-count">{{ state.currentTrick.length ? state.currentTrick.length + ' в розыгрыше' : 'Место для карт' }}</span>
              </div>

              <div class="table-center__slot">
                <span class="slot-heading">ОТБОЙ</span>
                <div class="discard-stack">
                  <CardComponent v-if="state.discardPile.length" hidden />
                  <div v-else class="empty-slot">✕</div>
                </div>
                <span class="slot-count">{{ state.discardPile.length }} карт</span>
              </div>
            </div>

            <div v-if="targeting" class="target-actions">
              <span>КУДА ПОЛОЖИТЬ КАРТУ?</span>
              <div class="target-actions__buttons">
                <button v-for="p in state.players" :key="p.id" type="button" @click="handleSeatClick(p.id)">
                  {{ p.id === gameStore.playerId ? 'СЕБЕ' : p.name }}
                </button>
              </div>
            </div>
            <div v-else-if="penaltyTargeting" class="target-actions">
              <span>КОМУ ПЕРЕДАТЬ КАРТУ?</span>
              <div class="target-actions__buttons">
                <button v-for="p in penaltyTargets" :key="p.id" type="button" @click="handleSeatClick(p.id)">{{ p.name }} · {{ state.pendingPenaltyDebts?.[p.id]?.[gameStore.playerId] }}</button>
                <button type="button" @click="selectedCard = null">ОТМЕНА</button>
              </div>
            </div>
          </div>
        </div>

        <section class="player-dock">
          <div class="player-dock__actions">
            <div class="trump">
              <div><small>КОЗЫРЬ</small><strong :class="{ 'trump--red': trumpIsRed }">{{ trumpSymbol }}</strong></div>
              <span>{{ state.trumpSuit ? 'В игре' : 'По последней карте' }}</span>
            </div>
            <div class="player-dock__buttons">
              <button v-if="canDraw" type="button" class="action-button action-button--gold" @click="drawCard">ВЗЯТЬ ИЗ КОЛОДЫ</button>
              <button v-if="isMyTurn && state.currentTrick.length && state.phase === 'MAIN_GAME'" type="button" class="action-button action-button--gold" @click="gameStore.takeTrick()">ЗАБРАТЬ НИЖНЮЮ</button>
              <button v-if="canTakeStumps" type="button" class="action-button action-button--gold" @click="gameStore.takeStumps()">БЕРУ ПЕНЬКИ!</button>
              <button v-if="canExitGame" type="button" class="action-button action-button--gold" @click="gameStore.exitGame()">С ПИДОРАМИ НЕ ИГРАЮ!</button>
              <span v-if="state.phase === 'MAIN_GAME' && !isMyTurn && !canTakeStumps && !canExitGame" class="action-hint">Дожидаемся хода</span>
              <span v-else-if="state.phase === 'PENALTY_DISTRIBUTION' && !selectedCard" class="action-hint">Выбери карту для передачи</span>
              <span v-else-if="state.phase === 'DEALING' && !isMyTurn" class="action-hint">Следи за картами на столе</span>
            </div>
          </div>
          <PlayerSeat v-if="me" :player="me" :is-me="true" :is-turn="isMyTurn"
            :phase="state.phase" :selected-card-id="selectedCard?.id"
            @card-click="handleCardClick" />
        </section>

        <div v-if="state.phase === 'ENDED'" class="game-ended">
          <div class="game-ended__panel">
            <div class="eyebrow">ПАРТИЯ ЗАВЕРШЕНА</div>
            <div class="game-ended__icon">♠</div>
            <h2>Вахта принята.</h2>
            <p><b>{{ loser?.name || 'Игрок' }}</b> остаётся на вахте. Ещё одну?</p>
            <button class="main-button" type="button" @click="newGame">НОВАЯ КОМНАТА <span>↗</span></button>
          </div>
        </div>
      </main>
    </template>
  </div>
</template>

<style scoped>
.app-shell { position: relative; isolation: isolate; width: 100%; min-height: 100dvh; min-height: var(--tg-height, 100dvh); overflow: hidden; display: flex; flex-direction: column; padding: env(safe-area-inset-top, 0px) max(14px, env(safe-area-inset-right, 0px)) env(safe-area-inset-bottom, 0px) max(14px, env(safe-area-inset-left, 0px)); background: #0b1718; color: #f1f0e8; }
.ambient { position: absolute; z-index: -1; pointer-events: none; border-radius: 50%; filter: blur(68px); opacity: .35; }
.ambient--top { width: 480px; height: 480px; left: -200px; top: -260px; background: #245746; }
.ambient--bottom { width: 440px; height: 440px; right: -240px; bottom: -260px; background: #584829; }
.site-header { height: 74px; min-height: 74px; display: flex; align-items: center; gap: 20px; width: min(100%, 1380px); align-self: center; border-bottom: 1px solid rgba(229,223,203,.12); }
.brand { display: flex; align-items: center; gap: 10px; letter-spacing: -.055em; font-size: 24px; font-weight: 950; line-height: 1; flex: none; }
.brand__mark { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 9px; background: #dbb575; color: #203127; font-family: Georgia,serif; font-weight: 900; font-size: 24px; transform: rotate(-5deg); letter-spacing: 0; }
.brand__dot { color: #e4bb75; }
.site-header__label { margin-left: auto; color: #92aa9e; text-transform: uppercase; letter-spacing: .13em; font-size: 11px; font-weight: 800; }
.landing { width: min(1100px,100%); margin: auto; display: grid; grid-template-columns: minmax(0,1.1fr) minmax(340px,.9fr); gap: clamp(28px,6vw,95px); align-items: center; padding: 45px 0 65px; }
.eyebrow { display: inline-flex; align-items: center; gap: 8px; color: #dcbd82; font-size: 11px; letter-spacing: .16em; font-weight: 900; }
.eyebrow__line { width: 22px; height: 2px; background: #dbb575; }
.landing__intro h1 { margin: 22px 0; font-size: clamp(42px,5.2vw,76px); line-height: 1.06; letter-spacing: -.065em; font-weight: 900; }
.landing__intro em { color: #e9bd79; font-style: normal; }
.landing__intro p { max-width: 470px; color: #a4b8ae; font-size: 16px; line-height: 1.75; }
.landing__suits { margin-top: 35px; display: flex; gap: 18px; color: #c3b898; font-family: Georgia,serif; font-size: 39px; opacity: .62; }
.landing__suits span:nth-child(even) { color: #cb7174; }
.join-panel, .lobby__panel { border: 1px solid rgba(216,193,144,.27); border-radius: 23px; padding: clamp(22px,3vw,34px); background: linear-gradient(155deg, rgba(29,54,49,.97), rgba(14,30,29,.98)); box-shadow: 0 20px 75px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.04); }
.join-panel { display: flex; flex-direction: column; gap: 20px; }
.join-panel__top h2 { margin: 10px 0 5px; font-size: 29px; font-weight: 900; letter-spacing: -.045em; }
.join-panel__top p { color: #a8b8ac; font-size: 12px; line-height: 1.6; }
.field { display: flex; flex-direction: column; gap: 8px; }
.field span { color: #c2c7b6; letter-spacing: .1em; font-size: 10px; font-weight: 900; }
.field input { width: 100%; min-width: 0; min-height: 50px; padding: 12px 15px; background: #102522; border: 1px solid #40554b; border-radius: 11px; color: #f5f0e5; outline: none; font-size: 16px; transition: border .15s ease; }
.field input:focus { border-color: #e9c27d; box-shadow: 0 0 0 3px rgba(234,196,135,.12); }
.field input::placeholder { color: #769086; }
.main-button { width: 100%; min-height: 53px; border: 0; border-radius: 11px; padding: 12px 18px; display: flex; justify-content: center; align-items: center; gap: 14px; background: linear-gradient(135deg,#f1cb89,#d9ae66); color: #172b25; font-size: 14px; font-weight: 950; letter-spacing: .09em; box-shadow: 0 6px 25px rgba(221,171,97,.13); cursor: pointer; touch-action: manipulation; }
.main-button:hover:not(:disabled) { filter: brightness(1.07); transform: translateY(-1px); }
.main-button:disabled { opacity: .6; cursor: wait; }
.main-button span { font-size: 20px; }
.main-button--secondary { background: #25463c; color: #ecddb9; border: 1px solid #617260; box-shadow: none; }
.join-panel__bottom { display: flex; justify-content: center; align-items: center; gap: 8px; color: #9cb0a3; font-size: 11px; }
.status-light { width: 7px; height: 7px; border-radius: 50%; background: #73c5a4; box-shadow: 0 0 0 4px rgba(115,197,164,.11); flex: none; }
.landing-footer { padding: 12px 0 21px; text-align: center; font-size: 10px; color: #607a71; letter-spacing: .16em; }
.site-header--game { height: 66px; min-height: 66px; }
.header-room { display: flex; flex-direction: column; min-width: 0; }
.header-room span { color: #87a294; font-size: 9px; font-weight: 900; letter-spacing: .14em; }
.header-room strong { color: #f1e0bd; font-size: 13px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.header-actions { margin-left: auto; display: flex; align-items: center; gap: 9px; }
.connection { display: flex; align-items: center; gap: 9px; font-size: 10px; font-weight: 900; letter-spacing: .07em; color: #a4c5b2; margin-right: 6px; white-space: nowrap; }
.connection--off .status-light { background: #d78273; box-shadow: 0 0 0 4px rgba(215,130,115,.12); }
.connection--off { color: #e5a79b; }
.subtle-button, .outline-button { border-radius: 9px; border: 1px solid rgba(231,225,200,.2); background: rgba(242,235,208,.06); color: #efe5c9; min-height: 36px; padding: 7px 13px; cursor: pointer; font-size: 11px; font-weight: 850; white-space: nowrap; touch-action: manipulation; }
.outline-button { border-color: rgba(236,193,122,.42); color: #eac991; }
.connection-alert { position: relative; z-index: 50; max-width: 620px; margin: 10px auto 0; padding: 8px 14px; text-align: center; color: #f3c3a4; background: #4a2626; border-radius: 8px; font-size: 12px; }
.penalty-toast { position: fixed; z-index: 80; top: calc(env(safe-area-inset-top) + 80px); left: 50%; transform: translateX(-50%); padding: 13px 20px; border-radius: 14px; color: #fff1df; background: #8c3a38; border: 1px solid #df8470; box-shadow: 0 15px 65px rgba(0,0,0,.4); width: max-content; max-width: 90vw; display: flex; flex-direction: column; gap: 3px; text-align: center; font-size: 12px; }
.penalty-toast strong { font-size: 17px; }
.toast-enter-active,.toast-leave-active { transition: opacity .2s ease,transform .2s ease; }
.toast-enter-from,.toast-leave-to { opacity: 0; transform: translate(-50%,-15px); }
.rules-sheet { position: fixed; z-index: 90; right: 20px; top: 77px; width: min(420px,calc(100vw - 40px)); padding: 20px; border: 1px solid #997d56; border-radius: 14px; background: #17332e; box-shadow: 0 24px 55px rgba(0,0,0,.5); font-size: 13px; max-height: 75dvh; overflow: auto; }
.rules-sheet p { margin: 14px 0; line-height: 1.6; color: #c5d5c6; }
.rules-sheet b { color: #f0d3a0; }
.rules-sheet__header { display: flex; justify-content: space-between; align-items: center; font-size: 17px; }
.rules-sheet__header button { border: none; background: none; font-size: 20px; color: #e2d9c4; cursor: pointer; }
.lobby { flex: 1; width: min(700px,100%); margin: auto; display: flex; flex-direction: column; justify-content: center; align-items: stretch; gap: 27px; padding: 24px 0; }
.lobby__heading { text-align: center; }
.lobby__heading h1 { font-size: clamp(30px,5vw,48px); line-height: 1.1; letter-spacing: -.05em; margin: 12px 0; font-weight: 900; }
.lobby__heading p { color: #a6bfb0; font-size: 14px; }
.lobby__panel { width: 100%; }
.lobby__top { display: flex; justify-content: space-between; color: #9ab9a5; letter-spacing: .08em; font-size: 11px; font-weight: 900; }
.lobby__top strong { color: #e2c088; font-size: 15px; }
.lobby__players { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 11px; margin: 20px 0; }
.lobby-person { display: flex; gap: 12px; align-items: center; padding: 14px; border: 1px solid #425747; background: #142e28; border-radius: 12px; min-width: 0; }
.lobby-person__avatar { display: grid; place-items: center; flex: none; width: 37px; height: 37px; background: #3b5c49; color: #f4d598; border-radius: 10px; font-size: 17px; font-weight: 900; }
.lobby-person__name { font-size: 13px; font-weight: 800; overflow-wrap: anywhere; }
.lobby-person__name span { color: #d6b473; font-size: 10px; }
.lobby-person--empty { border-style: dashed; color: #79988a; background: transparent; font-size: 12px; }
.lobby-person--empty .lobby-person__avatar { background: transparent; color: #719685; border: 1px dashed #608273; }
.lobby__notice { margin-top: 12px; color: #a1b6a7; font-size: 11px; text-align: center; }
.game-layout { display: flex; flex: 1; flex-direction: column; width: min(1440px,100%); margin: 0 auto; min-height: 0; position: relative; padding: 10px 0 12px; gap: 9px; }
.game-status { min-height: 42px; padding: 3px 9px; display: flex; align-items: center; gap: 15px; }
.game-status__phase { display: flex; align-items: center; gap: 7px; color: #e9cc94; white-space: nowrap; font-size: 13px; font-weight: 900; }
.phase-symbol { font-size: 21px; }
.game-status p { flex: 1; min-width: 0; font-size: 12px; color: #a8c3b3; line-height: 1.4; }
.your-turn,.whose-turn { border-radius: 50px; white-space: nowrap; font-size: 10px; font-weight: 900; letter-spacing: .06em; padding: 7px 11px; }
.your-turn { color: #1f3428; background: #eac37f; }
.whose-turn { color: #bcd0b9; background: #234337; }
.table-surface { flex: 1; min-height: 260px; position: relative; display: flex; flex-direction: column; border: 1px solid rgba(213,176,108,.48); border-radius: 38px; background: radial-gradient(ellipse at 50% 33%, #245d4b 0%, #174b3c 48%, #12372e 100%); box-shadow: inset 0 0 0 8px rgba(7,30,26,.42), inset 0 0 0 9px rgba(234,202,135,.18), 0 12px 40px rgba(0,0,0,.16); overflow: hidden; }
.table-surface__ring { position: absolute; inset: 23px; border-radius: 28px; border: 1px dashed rgba(245,212,150,.14); pointer-events: none; }
.opponents { z-index: 1; display: flex; justify-content: center; gap: 12px; align-items: flex-start; padding: 15px 12px 0; min-height: 110px; max-width: 100%; overflow-x: auto; scrollbar-width: thin; }
.table-center { position: relative; flex: 1; z-index: 1; min-height: 150px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 14px 14px 19px; gap: 14px; }
.table-center__label { font-size: 10px; letter-spacing: .22em; font-weight: 900; color: #aad0ac; opacity: .8; }
.table-center__cards { display: flex; width: min(560px,100%); justify-content: space-around; gap: 15px; align-items: start; }
.table-center__slot { display: flex; align-items: center; flex-direction: column; gap: 9px; min-width: 0; flex: 0 1 105px; }
.table-center__slot--trick { flex: 1 1 150px; }
.slot-heading { font-size: 10px; letter-spacing: .12em; color: #a0c2ae; font-weight: 900; }
.slot-count { color: #d7d9be; font-size: 11px; white-space: nowrap; }
.deck-button { border: 0; padding: 0; border-radius: 10px; background: transparent; cursor: default; }
.deck-button--available { cursor: pointer; filter: drop-shadow(0 0 9px rgba(235,197,124,.48)); animation: deck-pulse 2s ease-in-out infinite; }
.deck-button--available:focus-visible { outline: 3px solid #fbd893; outline-offset: 4px; }
.deck-button:disabled { opacity: .7; }
@keyframes deck-pulse { 50% { transform: translateY(-3px); filter: drop-shadow(0 0 16px rgba(248,213,143,.65)); } }
.trick-stack { position: relative; width: 100%; min-height: 115px; display: flex; justify-content: center; align-items: center; }
.trick-card { position: absolute !important; left: calc(50% - 36px); }
.active-card { position: absolute; z-index: 10; top: 0; left: 50%; transform: translate(-50%,-15px) rotate(-6deg); filter: drop-shadow(0 4px 13px rgba(0,0,0,.55)); }
.active-card--hidden { opacity: .85; }
.empty-slot { width: 80px; aspect-ratio: 5/7; border: 1.5px dashed rgba(225,210,154,.33); border-radius: 11px; display: grid; place-items: center; color: rgba(224,208,150,.4); font-size: 26px; }
.empty-slot--trick { font-size: 40px; }
.discard-stack { opacity: .56; transform: rotate(8deg); }
.target-actions { max-width: 92%; display: flex; align-items: center; flex-direction: column; gap: 9px; border-radius: 12px; border: 1px solid rgba(239,198,124,.38); padding: 11px 14px; background: rgba(10,33,29,.84); }
.target-actions > span { color: #efcf93; font-size: 10px; font-weight: 900; letter-spacing: .1em; }
.target-actions__buttons { display: flex; justify-content: center; flex-wrap: wrap; gap: 7px; }
.target-actions__buttons button { border: 1px solid #c5a46c; background: #315444; color: #f3e5be; padding: 7px 12px; border-radius: 9px; min-height: 35px; cursor: pointer; font-size: 11px; font-weight: 800; }
.target-actions__buttons button:hover { background: #476f56; }
.player-dock { flex: 0 0 auto; min-height: 0; width: min(100%, 1050px); align-self: center; }
.player-dock__actions { min-height: 54px; display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 0 8px 9px; }
.trump { display: flex; align-items: center; gap: 10px; }
.trump > div { display: flex; align-items: center; gap: 8px; padding: 5px 13px; background: #1b342d; border: 1px solid #49634c; border-radius: 10px; }
.trump small { font-size: 10px; color: #a2bca6; letter-spacing: .12em; font-weight: 900; }
.trump strong { font-family: Georgia,serif; font-size: 26px; color: #f6f2df; line-height: 1; }
.trump strong.trump--red { color: #e38283; }
.trump > span { color: #86a396; font-size: 10px; }
.player-dock__buttons { flex: 1; display: flex; justify-content: flex-end; align-items: center; }
.action-button { min-height: 41px; padding: 10px 15px; border: 1px solid #e2b66f; border-radius: 10px; background: #ebc47e; color: #193026; font-size: 11px; letter-spacing: .04em; font-weight: 950; cursor: pointer; touch-action: manipulation; }
.action-button:hover { filter: brightness(1.07); }
.action-hint { color: #819d8e; font-size: 11px; text-align: right; }
.game-ended { position: absolute; inset: 0; z-index: 45; display: grid; place-items: center; background: rgba(6,18,19,.78); backdrop-filter: blur(7px); }
.game-ended__panel { width: min(390px,calc(100% - 30px)); border: 1px solid #ab8b58; border-radius: 18px; padding: 35px; background: #1c362d; text-align: center; box-shadow: 0 30px 100px rgba(0,0,0,.6); }
.game-ended__icon { font-family: Georgia,serif; font-size: 72px; color: #d8b575; }
.game-ended__panel h2 { font-weight: 900; font-size: 29px; margin-bottom: 10px; }
.game-ended__panel p { font-size: 14px; color: #bcc9b8; line-height: 1.6; margin-bottom: 26px; }
.message--error { padding: 10px; border-radius: 8px; background: #693333; color: #ffd5ce; font-size: 12px; }
@media (max-width: 850px) {
  .landing { grid-template-columns: 1fr; max-width: 560px; gap: 25px; padding: 38px 0 45px; }
  .landing__intro h1 { font-size: clamp(40px,8vw,65px); }
  .landing__suits { margin-top: 14px; font-size: 28px; }
  .site-header { min-height: 63px; height: 63px; }
  .header-room strong { max-width: 130px; }
  .game-status p { font-size: 11px; }
}
@media (max-width: 680px) {
  .app-shell { padding-left: max(8px,env(safe-area-inset-left,0px)); padding-right: max(8px,env(safe-area-inset-right,0px)); }
  .site-header { padding: 0 5px; }
  .brand { font-size: 21px; gap: 7px; }
  .brand__mark { width: 28px; height: 28px; font-size: 20px; }
  .site-header--game { min-height: 57px; height: 57px; gap: 12px; }
  .site-header__label { font-size: 9px; }
  .header-room { flex: 1; }
  .header-room strong { max-width: 110px; font-size: 11px; }
  .header-actions { gap: 5px; }
  .header-actions .connection span:last-child { display: none; }
  .header-actions .connection { margin-right: 1px; }
  .subtle-button,.outline-button { min-height: 34px; font-size: 10px; padding: 7px 9px; }
  .landing { padding: 22px 12px 36px; }
  .landing__intro h1 { font-size: clamp(37px,10vw,55px); margin: 14px 0; }
  .landing__intro p { font-size: 14px; line-height: 1.6; }
  .join-panel { border-radius: 17px; padding: 22px; gap: 17px; }
  .lobby { padding: 30px 8px; }
  .lobby__players { gap: 7px; }
  .lobby-person { padding: 10px; gap: 7px; }
  .lobby-person__avatar { width: 31px; height: 31px; font-size: 13px; }
  .lobby-person__name { font-size: 11px; }
  .game-layout { gap: 5px; padding: 5px 0; }
  .game-status { display: grid; grid-template-columns: auto 1fr; gap: 3px 9px; min-height: 0; padding: 4px 8px 7px; }
  .game-status__phase { font-size: 11px; }
  .phase-symbol { font-size: 15px; }
  .game-status p { grid-column: 1/-1; grid-row: 2; font-size: 10px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
  .your-turn,.whose-turn { grid-column: 2; grid-row: 1; justify-self: end; padding: 4px 8px; font-size: 9px; }
  .table-surface { border-radius: 20px; min-height: 230px; box-shadow: inset 0 0 0 5px rgba(7,30,26,.42),inset 0 0 0 6px rgba(234,202,135,.14); }
  .table-surface__ring { inset: 12px; border-radius: 13px; }
  .opponents { padding: 12px 7px 0; gap: 6px; min-height: 82px; justify-content: flex-start; }
  .opponents:has(> :only-child) { justify-content: center; }
  .table-center { padding: 4px 10px 9px; gap: 5px; min-height: 138px; }
  .table-center__label { font-size: 8px; }
  .table-center__cards { gap: 8px; }
  .slot-heading { font-size: 9px; }
  .slot-count { font-size: 9px; }
  .table-center__slot { gap: 4px; flex-basis: 83px; }
  .table-center__slot--trick { flex-basis: 100px; }
  .trick-stack { min-height: 92px; }
  .trick-card { left: calc(50% - 30px); }
  .empty-slot { width: 68px; }
  .active-card { transform: translate(-50%,-8px) rotate(-6deg); }
  .target-actions { padding: 7px; gap: 5px; }
  .target-actions > span { font-size: 9px; }
  .target-actions__buttons button { min-height: 32px; padding: 5px 9px; font-size: 10px; }
  .player-dock__actions { padding-bottom: 5px; min-height: 41px; }
  .trump > div { padding: 3px 8px; gap: 5px; }
  .trump small { font-size: 9px; }
  .trump strong { font-size: 23px; }
  .trump > span { display: none; }
  .action-hint { display: none; }
  .action-button { min-height: 35px; padding: 8px 10px; font-size: 10px; }
}
@media (max-width: 380px) {
  .brand { font-size: 18px; }
  .header-room strong { max-width: 65px; }
  .subtle-button { display: none; }
  .site-header--game { gap: 7px; }
  .slot-count { font-size: 8px; }
  .trick-stack { min-height: 80px; }
  .table-center { min-height: 118px; }
}
@media (max-height: 740px) and (max-width: 680px) {
  .game-layout { overflow-y: auto; }
  .table-surface { flex: 0 0 auto; min-height: 260px; }
  .player-dock { flex: 0 0 auto; }
}
@media (max-height: 570px) and (orientation: landscape) {
  .game-layout { overflow-y: auto; }
  .table-surface { flex: 0 0 auto; min-height: 270px; }
}
@media (prefers-reduced-motion: reduce) {
  *,*::before,*::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
</style>
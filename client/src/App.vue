<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useGameStore } from './stores/game';
import PlayerSeat from './components/PlayerSeat.vue';
import CardComponent from './components/CardComponent.vue';
import HomeLobby from './components/HomeLobby.vue';
import { playSound, soundEnabled, toggleSound } from './audio/gameAudio';
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
const room = ref(new URLSearchParams(window.location.search).get('room') || '');
const selectedCard = ref<Card | null>(null);
const copied = ref(false);
const showRules = ref(false);
const accuseOpen = ref(false);
const latestDraw = ref<{ playerId: string; outOfTurn: boolean; forcedSelf: boolean; createdAt: number } | null>(null);
const deckPointerStart = ref<{x: number; y: number} | null>(null);
const deckDragY = ref(0);
const deckDragX = ref(0);
const ignoreClickUntil = ref(0);
const playMode = ref<'friends' | 'bot'>(new URLSearchParams(window.location.search).get('mode') === 'bot' ? 'bot' : 'friends');

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
watch(() => gameStore.gameState?.pendingPenaltyTurn?.giverId, () => { selectedCard.value = null; });
watch(() => gameStore.gameState?.lastDrawEvent?.createdAt, () => {
  const event = gameStore.gameState?.lastDrawEvent;
  if (!event || Date.now() - event.createdAt > 4500) return;
  latestDraw.value = event;
  setTimeout(() => { if (latestDraw.value === event) latestDraw.value = null; }, 3900);
});

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
  LOBBY: 'Лобби', DEALING: 'Набор карт', PENALTY_REVIEW: 'Разбор нарушений',
  PENALTY_DISTRIBUTION: 'Штрафные карты', MAIN_GAME: 'Основная игра',
  ENDED: 'Конец партии'
})[state.value?.phase || 'LOBBY']);
const trumpSymbol = computed(() => {
  const names: Record<string, string> = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
  return names[state.value?.trumpSuit || ''] || '—';
});
const trumpIsRed = computed(() => ['hearts','diamonds'].includes(state.value?.trumpSuit || ''));
const canDraw = computed(() => state.value?.phase === 'DEALING'
  && !!state.value.deck.length && !state.value.activeCard);
const riskyDraw = computed(() => state.value?.phase === 'DEALING' && !isMyTurn.value);
const canTakeStumps = computed(() => state.value?.phase === 'MAIN_GAME' && me.value?.hand.length === 0 && !!me.value.stumps.length && state.value?.currentTrick.length === 0);
const canExitGame = computed(() => state.value?.phase === 'MAIN_GAME' && me.value?.hand.length === 0 && me.value?.stumps.length === 0 && state.value?.currentTrick.length === 0 && !me.value.hasExited);
const targeting = computed(() => state.value?.phase === 'DEALING' && state.value?.activeCard?.ownerId === gameStore.playerId);
const dealtRank: Record<string, number> = { '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };
const dealTargets = computed(() => {
  if (!targeting.value || !state.value?.activeCard) return [];
  const card = state.value.activeCard.card;
  const seatOrder = [...others.value, ...(me.value ? [me.value] : [])];
  return seatOrder.filter(player => {
    if (player.id === gameStore.playerId) return true;
    const top = player.stumps[player.stumps.length - 1];
    if (!top || top.suit !== card.suit) return false;
    return (card.rank === '6' && top.rank === 'A') ||
      (dealtRank[card.rank] ?? 0) > (dealtRank[top.rank] ?? 0);
  });
});
const myPenaltyTurn = computed(() => state.value?.pendingPenaltyTurn?.giverId === gameStore.playerId);
const penaltyTargets = computed(() => myPenaltyTurn.value ? others.value.filter(p => p.id === state.value?.pendingPenaltyTurn?.receiverId) : []);
const penaltyTargeting = computed(() => state.value?.phase === 'PENALTY_DISTRIBUTION' && selectedCard.value !== null && penaltyTargets.value.length > 0);
const guidance = computed(() => {
  if (!state.value) return '';
  if (state.value.phase === 'DEALING') {
    if (targeting.value) return 'Положи карту по масти на подходящую карту игрока по кругу или себе.';
    if (isMyTurn.value) return 'Твоя очередь тянуть. Положи карту на подходящую масть по кругу.';
    return 'Сейчас ходит ' + (turnPlayer.value?.name || 'другой игрок') + '. Следи за ходом и картами на столе.';
  }
  if (state.value.phase === 'PENALTY_REVIEW') {
    return me.value?.isReady
      ? 'Разбор длится максимум 15 секунд. Ждём завершения или решения остальных.'
      : 'Вспомните нарушения. Назови нарушителя кнопкой «ПОХУЁВАЯ!» или закончи разбор.';
  }
  if (state.value.phase === 'PENALTY_DISTRIBUTION') {
    if (!myPenaltyTurn.value) {
      const giver = state.value.players.find(p => p.id === state.value?.pendingPenaltyTurn?.giverId);
      const receiver = state.value.players.find(p => p.id === state.value?.pendingPenaltyTurn?.receiverId);
      return giver ? 'Сейчас ' + giver.name + ' выдаёт похуёвую игроку ' + (receiver?.name || '…') : 'Ожидаем следующую штрафную карту.';
    }
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
function joinFromHome(payload: { name: string; room: string; mode: 'friends' | 'bot'; botCount: number }) {
  name.value = payload.name;
  room.value = payload.room;
  playMode.value = payload.mode;
  gameStore.joinRoom(payload.name, payload.room, payload.mode, payload.botCount);
}
function returnToLobby() {
  haptic();
  gameStore.leaveRoom();
  room.value = '';
  accuseOpen.value = false;
  showRules.value = false;
}

function handleCardClick({ card, ownerId }: { card: Card; ownerId: string }) {
  if (!state.value) return;
  haptic();
  if (state.value.phase === 'DEALING') {
    if (targeting.value) gameStore.placeActiveCard(ownerId);
    else if (ownerId === gameStore.playerId && isMyTurn.value) gameStore.takeFromPile(card.id);
  } else if (state.value.phase === 'MAIN_GAME') {
    if (isMyTurn.value) gameStore.playCard(card.id);
  } else if (state.value.phase === 'PENALTY_DISTRIBUTION' && ownerId === gameStore.playerId && myPenaltyTurn.value) {
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
function callOut(playerId: string) {
  if (playerId === gameStore.playerId) return;
  haptic();
  gameStore.accusePlayer(playerId);
  accuseOpen.value = false;
}
function readyReview() {
  haptic();
  gameStore.finishReview();
}
function drawCard() {
  if (canDraw.value) { haptic(); gameStore.drawCardFromDeck(); }
}
function beginDeckSwipe(event: PointerEvent) {
  if (!canDraw.value) return;
  deckPointerStart.value = { x: event.clientX, y: event.clientY };
  deckDragX.value = 0;
  deckDragY.value = 0;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}
function moveDeckSwipe(event: PointerEvent) {
  if (!deckPointerStart.value) return;
  deckDragY.value = Math.min(25, Math.max(-90, event.clientY - deckPointerStart.value.y));
  deckDragX.value = Math.min(45, Math.max(-45, event.clientX - deckPointerStart.value.x));
}
function endDeckSwipe(event: PointerEvent) {
  if (!deckPointerStart.value) return;
  const distance = Math.hypot(event.clientX - deckPointerStart.value.x, event.clientY - deckPointerStart.value.y);
  const isSwipe = distance > 42;
  deckPointerStart.value = null;
  deckDragX.value = 0;
  deckDragY.value = 0;
  if (isSwipe) {
    ignoreClickUntil.value = Date.now() + 450;
    drawCard();
  }
}
function clickDeck() {
  if (Date.now() > ignoreClickUntil.value) drawCard();
}
function cancelDeckSwipe() {
  deckPointerStart.value = null;
  deckDragX.value = 0;
  deckDragY.value = 0;
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
  const botGame = state.value?.mode === 'bot';
  if (!botGame) { returnToLobby(); return; }
  room.value = 'solo-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  gameStore.joinRoom(gameStore.playerName || name.value, room.value, 'bot',
    Math.max(1, state.value?.players.filter(p => p.isBot).length || 1));
}
watch(() => gameStore.gameState?.phase, (next, prev) => {
  if (next === prev) return;
  if (next === 'DEALING') playSound('shuffle');
  if (next === 'ENDED') playSound('finish');
});
watch(() => gameStore.gameState?.currentTrick.length, (next, prev) => {
  if (prev !== undefined && next !== undefined && next > prev) playSound('place');
});
watch(() => gameStore.gameState?.turnIndex, (next, prev) => {
  if (next !== prev && isMyTurn.value && state.value?.phase !== 'LOBBY') playSound('turn');
});
watch(() => gameStore.penaltySplash, show => { if (show) playSound('penalty'); });

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
      <HomeLobby :initial-name="name" :initial-room="room"
        :initial-mode="playMode" :connecting="gameStore.connecting"
        :server-error="gameStore.error" @start="joinFromHome" />

      <footer class="landing-footer">PIDOR · ИГРАЙ ПО ПРАВИЛАМ, ЕСЛИ СМОЖЕШЬ</footer>
    </template>

    <template v-else-if="state">
      <header class="site-header site-header--game">
        <div class="brand"><span class="brand__mark">P</span><span>PIDOR<span class="brand__dot">.</span></span></div>
        <div class="header-room">
          <span>КОМНАТА</span>
          <strong>{{ state.mode === 'bot' ? 'ПРОТИВ БОТОВ' : gameStore.roomId }}</strong>
        </div>
        <div class="header-actions">
          <button class="subtle-button lobby-return" type="button" @click="returnToLobby"><span class="desktop-label">⌂ Столы</span><span class="mobile-label">⌂</span></button>
          <button class="sound-icon" type="button" :aria-label="soundEnabled ? 'Выключить звук' : 'Включить звук'" @click="toggleSound">{{ soundEnabled ? '♫' : '♪' }}</button>
          <div class="connection" :class="{ 'connection--off': !gameStore.connected }">
            <span class="status-light"></span>
            <span>{{ gameStore.connected ? 'В СЕТИ' : 'НЕТ СВЯЗИ' }}</span>
          </div>
          <button v-if="['DEALING', 'PENALTY_REVIEW', 'MAIN_GAME'].includes(state.phase)" type="button" class="callout-button" @click="accuseOpen = true">ПОХУЁВАЯ!</button>
          <button class="subtle-button" type="button" @click="showRules = !showRules">{{ showRules ? 'Закрыть' : 'Правила' }}</button>
          <button v-if="state.mode === 'bot'" class="outline-button" type="button" @click="newGame">Новая партия ↻</button>
          <button v-else class="outline-button" type="button" @click="invite">{{ copied ? 'Скопировано ✓' : 'Пригласить ↗' }}</button>
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

      <Transition name="penalty-reveal">
        <div v-if="gameStore.penaltySplash" class="penalty-reveal" role="alert" aria-live="assertive">
          <div class="penalty-reveal__card" aria-hidden="true">!</div>
          <strong>ПОХУЕВАЯ!</strong>
          <span>Тебе прилетела штрафная карта</span>
        </div>
      </Transition>

      <Transition name="toast">
        <div v-if="gameStore.verdictToast" class="verdict-toast" role="status">
          <strong>{{ gameStore.verdictToast.correct ? 'ОБВИНЕНИЕ ПОДТВЕРЖДЕНО' : 'ЛОЖНОЕ ОБВИНЕНИЕ!' }}</strong>
          <span>ПОХУЁВАЯ: {{ state.players.find(p => p.id === gameStore.verdictToast?.penalizedId)?.name }}</span>
          <small>{{ gameStore.verdictToast.reason }}</small>
        </div>
      </Transition>

      <div v-if="accuseOpen" class="accusation-backdrop" @click.self="accuseOpen = false">
        <div class="accusation-sheet" role="dialog" aria-modal="true" aria-labelledby="accuse-title">
          <div class="accusation-sheet__header">
            <strong id="accuse-title">ПОХУЁВАЯ!</strong>
            <button type="button" aria-label="Закрыть" @click="accuseOpen = false">✕</button>
          </div>
          <p>У тебя 15 секунд с момента нарушения, чтобы назвать игрока. Успел и прав — похуёвая нарушителю. Ошибся или опоздал — штраф тебе. Не заметили вовремя — игрок успешно смухлевал.</p>
          <div class="accusation-sheet__players">
            <button v-for="p in others.filter(p => !p.hasExited)" :key="p.id" type="button" @click="callOut(p.id)">
              <span>{{ p.name.charAt(0).toUpperCase() }}</span>{{ p.name }} <small v-if="p.isBot">БОТ</small>
            </button>
          </div>
          <button type="button" class="accusation-sheet__cancel" @click="accuseOpen = false">Отмена</button>
        </div>
      </div>

      <div v-if="showRules" class="rules-sheet">
        <div class="rules-sheet__header"><strong>Кратко о правилах</strong><button type="button" @click="showRules = false" aria-label="Закрыть правила">✕</button></div>
        <p><b>01 · Набор.</b> Тяните карту по очереди. Карту старше открытой кладите на первую подходящую стопку той же масти по кругу. Шестёрка бьёт туза. Последнюю карту колоды оставьте себе.</p>
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
        <div v-if="state.phase === 'PENALTY_REVIEW'" class="review-bar">
          <div>
            <strong>Разбор нарушений</strong>
            <p>Последние 15 секунд для обвинений. За неподтверждённое обвинение штраф получает обвинитель. После отсчёта разбор закончится автоматически.</p>
            <small>Готовы: {{ state.players.filter(p => p.isReady || p.isBot).length }} / {{ state.players.length }}</small>
          </div>
          <button type="button" :disabled="!!me?.isReady" @click="readyReview">{{ me?.isReady ? 'ОЖИДАЕМ ОСТАЛЬНЫХ…' : 'ЗАКОНЧИТЬ РАЗБОР' }}</button>
        </div>
        <div v-if="state.phase === 'DEALING'" class="drawer-banner" :class="{ 'drawer-banner--mine': isMyTurn }">
          <div class="drawer-banner__label">КТО ТЯНЕТ СЕЙЧАС</div>
          <div class="drawer-banner__name"><span class="drawer-banner__avatar">{{ turnPlayer?.name?.charAt(0).toUpperCase() }}</span><strong>{{ turnPlayer?.name }}</strong></div>
          <div class="drawer-banner__badge">{{ isMyTurn ? 'ТВОЙ ХОД' : 'ИДЁТ ХОД СОПЕРНИКА' }}</div>
        </div>
        <Transition name="toast">
          <div v-if="latestDraw && state.phase === 'DEALING'" class="draw-activity" role="status">
            <strong>{{ state.players.find(p => p.id === latestDraw?.playerId)?.name }} вытянул карту</strong>
            <span>Карта вытянута из колоды</span>
          </div>
        </Transition>
        <div class="table-surface">
          <div class="table-surface__ring" aria-hidden="true"></div>
          <div class="table-ornament table-ornament--tl" aria-hidden="true"></div>
          <div class="table-ornament table-ornament--tr" aria-hidden="true"></div>
          <div class="table-ornament table-ornament--bl" aria-hidden="true"></div>
          <div class="table-ornament table-ornament--br" aria-hidden="true"></div>
          <div class="opponents">
            <PlayerSeat
              v-for="p in others" :key="p.id"
              :player="p" :is-me="false"
              :phase="state.phase"
              :is-turn="turnPlayer?.id === p.id"
              :targetable="((targeting && dealTargets.some(target => target.id === p.id)) || (penaltyTargeting && penaltyTargets.some(target => target.id === p.id))) && !p.hasExited"
              @click="handleSeatClick(p.id)" @card-click="handleCardClick"
            />
          </div>

          <div class="table-center">
            <div class="table-center__label">ИГРОВОЙ СТОЛ</div>
            <div class="table-center__cards">
              <div class="table-center__slot table-center__slot--deck">
                <span class="slot-heading">КОЛОДА</span>
                <button
                  type="button" class="deck-button" :class="{ 'deck-button--available': canDraw, 'deck-button--risky': canDraw && riskyDraw }"
                  :disabled="!canDraw" aria-label="Вытянуть карту из колоды"
                  title="Вытянуть карту"
                  :style="deckPointerStart ? { transform: 'translate(' + deckDragX + 'px,' + deckDragY + 'px) rotate(' + (deckDragX / 8) + 'deg)' } : {}"
                  @pointerdown="beginDeckSwipe" @pointermove="moveDeckSwipe"
                  @pointerup="endDeckSwipe" @pointercancel="cancelDeckSwipe"
                  @click="clickDeck"
                >
                  <CardComponent v-if="state.deck.length" hidden />
                  <div v-else class="empty-slot">0</div>
                </button>
                <span class="slot-count">{{ state.deck.length }} карт</span>
                <span v-if="canDraw" class="deck-swipe-hint">↑ СВАЙПНИ</span>
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
                  <div v-if="state.activeCard" :key="state.activeCard.card.id" class="active-card" :class="{ 'active-card--hidden': state.activeCard.card.id.startsWith('masked-'), 'active-card--drawn': state.activeCard.fromDeck }">
                    <CardComponent :card="state.activeCard.card" :hidden="state.activeCard.card.id.startsWith('masked-')" />
                  </div>
                </div>
                <span class="slot-count">{{ state.currentTrick.length ? state.currentTrick.length + ' в розыгрыше' : 'Место для карт' }}</span>
              </div>

              <div class="table-center__slot table-center__slot--discard">
                <span class="slot-heading">ОТБОЙ</span>
                <div class="discard-stack">
                  <CardComponent v-if="state.discardPile.length" hidden />
                  <div v-else class="empty-slot">✕</div>
                </div>
                <span class="slot-count">{{ state.discardPile.length }} карт</span>
              </div>

              <div class="table-center__slot table-center__slot--trump">
                <span class="slot-heading">КОЗЫРЬ</span>
                <div class="trump-display" :class="{ 'trump-display--red': trumpIsRed }">
                  <span class="trump-display__star">✦</span>
                  <strong>{{ state.trumpSuit ? trumpSymbol : state.phase === 'DEALING' ? '?' : '—' }}</strong>
                  <span class="trump-display__star">✦</span>
                </div>
                <span class="slot-count">{{ state.phase === 'DEALING' ? 'Последняя карта' : state.trumpSuit ? 'Масть в игре' : 'Без козыря' }}</span>
              </div>
            </div>

            <div v-if="targeting" class="target-actions">
              <span>КУДА ПОЛОЖИТЬ КАРТУ?</span>
              <div class="target-actions__buttons">
                <button v-for="p in dealTargets" :key="p.id" type="button" @click="handleSeatClick(p.id)">
                  {{ p.id === gameStore.playerId ? 'СЕБЕ' : p.name }}
                  <small v-if="p.id !== gameStore.playerId && p.id === dealTargets.find(x => x.id !== gameStore.playerId)?.id">· ПО КРУГУ</small>
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
              <span>{{ state.phase === 'DEALING' ? 'По последней карте' : state.trumpSuit ? 'В игре' : 'БЕЗ КОЗЫРЯ' }}</span>
            </div>
            <div class="player-dock__buttons">
              <button v-if="canDraw" type="button" class="action-button action-button--gold" :class="{ 'action-button--risky': riskyDraw }" @click="drawCard">ВЗЯТЬ ИЗ КОЛОДЫ</button>
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
            <button class="main-button" type="button" @click="newGame">{{ state.mode === 'bot' ? 'РЕВАНШ С БОТОМ' : 'НОВАЯ КОМНАТА' }} <span>↗</span></button>
          </div>
        </div>
      </main>
    </template>
  </div>
</template>

<style scoped>
.app-shell { position: relative; isolation: isolate; width: 100%; min-height: 100dvh; min-height: var(--tg-height, 100dvh); overflow-x: hidden; overflow-y: auto; display: flex; flex-direction: column; padding: env(safe-area-inset-top, 0px) max(14px, env(safe-area-inset-right, 0px)) env(safe-area-inset-bottom, 0px) max(14px, env(safe-area-inset-left, 0px)); background: #0b1718; color: #f1f0e8; }
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
.player-dock { flex: 0 0 auto; min-height: 0; width: min(100%, 1400px); align-self: center; }
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

.mode-picker { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px; }
.mode-picker__button { min-height: 89px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; padding: 10px; background: rgba(11,29,27,.7); border: 1px solid rgba(171,192,167,.24); border-radius: 12px; color: #f2e8d5; cursor: pointer; touch-action: manipulation; }
.mode-picker__button--active { border-color: #dfb870; background: rgba(82,70,41,.38); box-shadow: inset 0 0 0 1px rgba(240,196,112,.2); }
.mode-picker__button span:not(.mode-picker__icon) { font-weight: 900; font-size: 12px; }
.mode-picker__button small { font-size: 10px; color: #93b5a4; }
.mode-picker__button--active small { color: #e2c993; }
.mode-picker__icon { font-family: Georgia,serif; font-size: 23px; color: #eac580; line-height: 1; }
.bot-select { width: 100%; background: #102522; border: 1px solid #40554b; color: #f3e6ca; border-radius: 11px; min-height: 50px; padding: 10px 12px; font-size: 16px; }
.bot-select:focus { outline: 2px solid #e9c27d; }
.field .bot-note { font-size: 11px; font-weight: 500; letter-spacing: 0; color: #a1baa6; line-height: 1.4; }

.deck-button--available { touch-action: none; transition: transform .12s ease-out; }
.deck-button--available :deep(.playing-card) { pointer-events: none; }
.deck-swipe-hint { font-size: 9px; font-weight: 900; color: #f5d693; letter-spacing: .1em; white-space: nowrap; }
.active-card--drawn { animation: card-from-deck .46s cubic-bezier(.2,.85,.25,1.1) both; }
@keyframes card-from-deck {
  from { opacity: .45; transform: translate(-235%,-18px) rotate(-34deg) scale(.8); filter: blur(2px); }
  to { opacity: 1; transform: translate(-50%,-15px) rotate(-6deg) scale(1); filter: blur(0); }
}
.trick-card { animation: trick-entry .32s cubic-bezier(.2,.8,.25,1.05) both; }
@keyframes trick-entry { from { opacity: 0; scale: .82; } to { opacity: 1; scale: 1; } }
.penalty-reveal { position: fixed; z-index: 300; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 16px; padding: max(25px,env(safe-area-inset-top)) 18px max(25px,env(safe-area-inset-bottom)); text-align: center; background: radial-gradient(ellipse at center,rgba(157,39,36,.95),rgba(46,9,16,.96)); backdrop-filter: blur(12px); pointer-events: none; }
.penalty-reveal__card { width: 92px; height: 128px; border-radius: 12px; border: 4px solid #f0c783; background: repeating-linear-gradient(45deg,#be3832 0 11px,#a52a28 11px 22px); color: #fff2d7; font-family: Georgia,serif; font-size: 100px; font-weight: 900; line-height: 120px; transform: rotate(-12deg); box-shadow: 0 15px 50px rgba(0,0,0,.35); animation: penalty-card-pop .48s cubic-bezier(.1,1.4,.4,1) both; }
.penalty-reveal strong { color: #ffe3a6; font-size: clamp(39px,11vw,102px); line-height: 1.04; letter-spacing: -.055em; font-weight: 1000; text-shadow: 0 5px 14px #320000; animation: penalty-title-pop .5s .1s both; }
.penalty-reveal span { color: #ffe7cf; font-size: clamp(14px,2.5vw,19px); letter-spacing: .035em; }
.penalty-reveal-enter-active,.penalty-reveal-leave-active { transition: opacity .22s ease,filter .22s ease; }
.penalty-reveal-enter-from,.penalty-reveal-leave-to { opacity: 0; filter: blur(8px); }
@keyframes penalty-card-pop { from { opacity: 0; transform: translateY(-80px) rotate(-38deg) scale(1.7); } to { opacity: 1; transform: translateY(0) rotate(-12deg) scale(1); } }
@keyframes penalty-title-pop { from { opacity: 0; transform: scale(.58); } to { opacity: 1; transform: scale(1); } }
@media(max-width:680px) { .active-card--drawn { animation: card-from-deck-mobile .38s cubic-bezier(.2,.85,.25,1.1) both; } }
@keyframes card-from-deck-mobile { from { opacity: 0; transform: translate(-155%,-4px) rotate(-29deg) scale(.76); } to { opacity: 1; transform: translate(-50%,-8px) rotate(-6deg); } }
@media(prefers-reduced-motion: reduce) { .active-card--drawn,.trick-card,.penalty-reveal__card,.penalty-reveal strong { animation: none !important; } }


.callout-button { border:1px solid #ef9280; background:linear-gradient(125deg,#8e302d,#6b242a); color:#fff0dd; min-height:38px; padding:7px 12px; border-radius:9px; font-size:11px; font-weight:950; white-space:nowrap; box-shadow:0 2px 18px rgba(185,52,48,.12); cursor:pointer; touch-action:manipulation; }
.callout-button:hover { filter:brightness(1.17); }
.accusation-backdrop { position:fixed; z-index:250; inset:0; display:grid; place-items:center; padding:18px; background:rgba(3,12,13,.83); backdrop-filter:blur(6px); }
.accusation-sheet { width:min(420px,100%); border:1px solid #cb835e; border-radius:19px; padding:24px; background:linear-gradient(160deg,#3e2728,#182b28); box-shadow:0 30px 100px rgba(0,0,0,.65); }
.accusation-sheet__header { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.accusation-sheet__header strong { color:#ffe0a9; font-size:clamp(23px,6vw,35px); font-weight:1000; letter-spacing:-.035em; }
.accusation-sheet__header button { border:0; background:transparent; color:#eed3bb; font-size:20px; cursor:pointer; }
.accusation-sheet p { color:#e3cbb9; font-size:13px; line-height:1.6; margin:11px 0 19px; }
.accusation-sheet__players { display:grid; gap:8px; max-height:43dvh; overflow-y:auto; }
.accusation-sheet__players button { text-align:left; display:flex; align-items:center; gap:11px; padding:9px 12px; min-height:49px; border:1px solid rgba(242,200,155,.25); color:#f5ecd9; border-radius:10px; background:rgba(34,62,50,.75); font-weight:900; cursor:pointer; }
.accusation-sheet__players button:hover { border-color:#f7c996; background:#395b47; }
.accusation-sheet__players button>span { display:grid; place-items:center; width:30px; height:30px; border-radius:8px; color:#f0d5a3; background:#345b47; }
.accusation-sheet__players button small { margin-left:auto; color:#e4bd82; }
.accusation-sheet__cancel { width:100%; margin-top:17px; border:0; background:transparent; color:#abbdab; font-weight:800; cursor:pointer; padding:9px; }
.verdict-toast { position:fixed; z-index:230; top:calc(env(safe-area-inset-top) + 118px); left:50%; transform:translateX(-50%); width:max-content; max-width:92vw; display:flex; flex-direction:column; align-items:center; gap:3px; padding:12px 18px; border-radius:12px; color:#ffe5bb; background:#55312d; border:1px solid #e6a373; box-shadow:0 10px 45px #0009; font-size:12px; text-align:center; }
.verdict-toast strong { font-size:13px; color:#fff0cc; }
.verdict-toast small { color:#dfc2a6; }
.review-bar { display:flex; justify-content:space-between; align-items:center; gap:13px; padding:11px 16px; border-radius:12px; border:1px solid rgba(233,185,120,.5); background:rgba(85,59,34,.7); }
.review-bar strong { font-size:14px; color:#ffe0a5; }
.review-bar p { margin:4px 0; font-size:11px; color:#f0d6b1; line-height:1.4; }
.review-bar small { color:#dec79a; font-weight:800; }
.review-bar button { flex:none; min-height:40px; padding:9px 14px; background:#e6bf7d; color:#202a23; border:0; border-radius:9px; font-size:11px; font-weight:950; cursor:pointer; }
.review-bar button:disabled { opacity:.48; cursor:default; }
@media(max-width:700px) {
  .callout-button { font-size:10px; min-height:33px; padding:5px 8px; }
  .header-actions { gap:4px; }
  .review-bar { flex-direction:column; align-items:stretch; padding:9px 12px; }
  .review-bar button { width:100%; }
  .accusation-sheet { padding:17px; }
}
@media(max-width:380px) {
  .site-header--game .brand { font-size:17px; }
  .callout-button { font-size:9px; padding:4px 7px; }
  .header-room { display:none; }
}


.drawer-banner { width:100%; display:flex; align-items:center; justify-content:center; gap:16px; padding:8px 14px; border:1px solid rgba(204,182,128,.3); background:rgba(29,59,49,.75); border-radius:13px; }
.drawer-banner--mine { border-color:#f2c77b; box-shadow:inset 0 0 0 1px rgba(243,202,130,.11); }
.drawer-banner__label { color:#9cc1a9; font-size:10px; font-weight:900; letter-spacing:.14em; }
.drawer-banner__name { display:flex; align-items:center; gap:8px; min-width:0; }
.drawer-banner__name strong { color:#f5d99f; font-size:16px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.drawer-banner__avatar { width:25px; height:25px; border-radius:50%; background:#496c53; color:#ffe5af; font-weight:900; font-size:12px; display:grid; place-items:center; flex:none; }
.drawer-banner__badge { padding:5px 10px; border-radius:30px; background:#2a4d3c; color:#d3e3c5; font-size:9px; letter-spacing:.06em; font-weight:900; white-space:nowrap; }
.drawer-banner--mine .drawer-banner__badge { background:#edca8c; color:#203728; }
.deck-button--risky { filter:drop-shadow(0 0 10px rgba(227,103,98,.45)); }
.deck-button--risky:focus-visible { outline-color:#f8a3a3; }
.action-button--risky { border-color:#e88c7f; background:#793c35; color:#ffe0ce; font-size:10px; }
.draw-activity { position:absolute; z-index:20; top:122px; left:50%; transform:translateX(-50%); display:flex; flex-direction:column; align-items:center; gap:3px; min-width:190px; max-width:90%; padding:11px 15px; text-align:center; color:#f3e7d0; background:rgba(23,47,40,.98); border:1px solid #d3b37d; border-radius:12px; box-shadow:0 15px 40px rgba(0,0,0,.27); pointer-events:none; }
.draw-activity strong { font-size:12px; }
.draw-activity span { font-size:10px; color:#efd39b; }
@media(max-width:700px) {
 .drawer-banner { gap:8px; padding:6px 9px; justify-content:space-between; }
 .drawer-banner__label { font-size:8px; letter-spacing:.05em; }
 .drawer-banner__name strong { font-size:12px; max-width:92px; }
 .drawer-banner__avatar { width:22px; height:22px; }
 .drawer-banner__badge { font-size:8px; padding:4px 7px; }
 .action-button--risky { max-width:230px; font-size:9px; }
 .draw-activity { top:112px; }
}
@media(max-width:370px){ .drawer-banner__label{max-width:69px;} .drawer-banner__badge{font-size:7px;} }


/* Village tavern board: old planks, weathered brass, coarse green cloth. */
.app-shell {
  background:
    radial-gradient(ellipse 65% 55% at 55% 30%, rgba(165,114,53,.17), transparent 75%),
    repeating-linear-gradient(0deg, rgba(16,8,4,.34) 0 2px, transparent 2px 107px, rgba(8,4,3,.65) 107px 112px),
    repeating-linear-gradient(89deg, #362417 0px, #422a18 31px, #322015 77px, #4c321d 103px, #332214 161px);
}
.app-shell::before {
  content: "";
  position: fixed;
  z-index: -1;
  pointer-events: none;
  inset: 0;
  opacity: .29;
  background:
    repeating-linear-gradient(92deg, transparent 0 9px, rgba(13,7,4,.25) 10px, transparent 12px 42px, rgba(228,180,111,.06) 45px 47px, transparent 49px 83px),
    repeating-linear-gradient(1deg, transparent 0 22px, rgba(240,177,91,.04) 23px 24px, transparent 25px 48px);
}
.site-header {
  border-bottom: 1px solid rgba(235,188,112,.23);
  background: linear-gradient(180deg,rgba(24,14,10,.30),transparent);
}
.brand__mark { background:linear-gradient(140deg,#f5d9a3,#b58145); box-shadow: inset 0 1px 2px #fff8,0 3px 8px #0906057a; }
.join-panel,.lobby__panel {
  background:
    linear-gradient(158deg,rgba(52,37,25,.97),rgba(26,30,23,.98)),
    repeating-linear-gradient(87deg,transparent 0 18px,rgba(208,165,97,.12) 19px 20px);
  border: 2px solid rgba(182,133,75,.57);
  box-shadow: 0 18px 55px rgba(0,0,0,.43), inset 0 0 0 3px rgba(247,200,130,.06);
}
.landing__intro em { color: #f5d396; }
.landing__suits { color:#e4c18b; }
.field input,.bot-select { background:#261d17; border-color:#7a6041; }
.field input:focus,.bot-select:focus { border-color:#e7bd78; }
.game-layout { padding-top: 12px; }
.game-status {
  padding:8px 15px;
  border: 1px solid rgba(223,178,113,.28);
  border-radius: 13px;
  background:linear-gradient(105deg,rgba(31,23,17,.81),rgba(38,47,32,.55));
  box-shadow:inset 0 1px 0 rgba(248,211,144,.1);
}
.table-surface {
  border: 12px solid #50321f;
  border-radius: 49px;
  background:
    radial-gradient(circle at 46% 32%,rgba(221,205,132,.09) 0%,transparent 52%),
    repeating-linear-gradient(27deg,rgba(255,233,159,.012) 0 1px, transparent 1px 3px),
    radial-gradient(ellipse at 48% 40%,#355f42 0%,#244b36 58%,#172d24 100%);
  box-shadow:
    0 0 0 2px #bc8e55,
    0 0 0 5px rgba(39,22,12,.73),
    inset 0 0 0 2px rgba(211,163,99,.60),
    inset 0 0 23px 5px rgba(8,16,10,.70),
    0 23px 42px rgba(0,0,0,.38);
}
.table-surface::after {
  content:""; position:absolute; inset:17px; pointer-events:none;
  border-radius:28px; z-index:0; opacity:.75;
  background:radial-gradient(ellipse at 20% 27%,rgba(255,226,157,.065),transparent 52%);
  animation: tavern-light 12s ease-in-out infinite alternate;
}
@keyframes tavern-light { from { opacity:.47; transform:scale(1); } to { opacity:1; transform:scale(1.012); } }
.table-surface__ring { inset:17px; border-color:rgba(227,200,135,.20); border-radius:31px; }
.opponents { z-index:1; }
.table-center { z-index:1; }
.table-center__label { color:#f1d7a1; text-shadow:0 1px 8px #061f13; }
.player-dock {
  border: 1px solid rgba(184,139,76,.53);
  border-radius:15px;
  background:linear-gradient(120deg,rgba(40,29,20,.94),rgba(23,36,28,.94));
  padding:10px 14px;
  box-shadow: 0 12px 33px rgba(0,0,0,.34),inset 0 0 0 1px rgba(234,194,128,.05);
}
.drawer-banner { border:1px solid #a77e48; background:linear-gradient(90deg,#3d2b1c,#382f20 40%,#4e341f); box-shadow:inset 0 1px 0 rgba(255,225,170,.1),0 4px 14px rgba(0,0,0,.17); }
.drawer-banner__avatar { background:#674d32; }
.drawer-banner__badge { background:#634828; }
.slot-heading,.slot-count { color:#ebd7ad; text-shadow:0 1px 4px #06190c; }
.action-button--gold,.main-button { background:linear-gradient(160deg,#f1d59c,#be8c4a); box-shadow:inset 0 1px 0 rgba(255,255,255,.48),0 4px 10px rgba(0,0,0,.15); }
.playing-card { box-shadow:0 5px 18px #0007; }
.deck-button:not(:disabled):hover { transform:translateY(-3px) rotate(1deg); }
.action-button--risky { background:linear-gradient(130deg,#d0a65f,#bc8749); color:#2c2114; border-color:#e4ba75; }
.penalty-toast,.verdict-toast { animation: stamp-in .24s ease-out both; }
@keyframes stamp-in { from { opacity:.25; transform:translate(-50%,-18px) scale(.92); } to { opacity:1; transform:translate(-50%,0) scale(1); } }
@media(max-width:680px) {
  .app-shell { background: repeating-linear-gradient(89deg,#3d291b,#2f1e15 80px,#4c311e 170px); }
  .table-surface { border-width:6px; border-radius:25px; box-shadow:0 0 0 1px #bd9059,inset 0 0 12px #0c1a12,0 12px 25px #0007; }
  .table-surface::after { inset:7px; border-radius:18px; }
  .table-surface__ring { inset:8px; border-radius:15px; }
  .player-dock { padding:7px; border-radius:12px; }
  .game-status { padding:5px 8px; }
}
@media(prefers-reduced-motion:reduce) {
  .table-surface::after,.penalty-toast,.verdict-toast { animation:none!important; }
}


.sound-icon { display:grid;place-items:center; min-width:33px;min-height:33px;border-radius:10px;color:#f0d49e;background:#213d30;border:1px solid #8d734e;cursor:pointer;font-weight:900;font-size:15px; }
.mobile-label { display:none; }
@media(max-width:680px) {
  .site-header--game .brand > span:nth-child(2) { display:none; }
  .site-header--game .header-room strong { max-width:84px; }
  .sound-icon { min-width:28px; min-height:30px; }
  .lobby-return { padding:5px 7px;min-width:30px; }
  .desktop-label { display:none; }
  .mobile-label { display:inline; font-size:18px; }
  .site-header--game .subtle-button:not(.lobby-return) { display:none; }
}


/* Wooden table inspired by a rural card-room: warm carved oak, green felt,
   wheat-gold inlays and hand-painted floral corners. */
.app-shell { background:
  radial-gradient(ellipse at 78% -8%,rgba(230,155,78,.17),transparent 43%),
  radial-gradient(ellipse at -15% 75%,rgba(219,139,69,.1),transparent 45%),
  repeating-linear-gradient(87deg,#4a2b1c 0 1px,#563521 3px 15px,#3b2418 18px 20px,#512e1e 23px 56px,#382519 64px 70px);
}
.site-header { border-bottom-color:rgba(233,192,120,.23); }
.site-header .brand { color:#f5d5a1; text-shadow:0 3px 18px #140c08; }
.site-header__label { color:#d8b883; }
.lobby__heading h1 { font-family:Georgia,serif; color:#f7ddb0; }
.lobby__panel { background:
  radial-gradient(ellipse at 15% 0%,rgba(255,227,150,.085),transparent 48%),
  linear-gradient(145deg,#173d2a,#102d21);
  border:10px solid #603d23; outline:2px solid #b38750; outline-offset:-13px;
  box-shadow:0 0 0 2px #a77c4b,0 25px 55px #0007,inset 0 0 45px #091709;
}
.lobby-person { border:1px solid #977c4d;background:linear-gradient(145deg,#244630,#183525); }
.lobby-person__avatar { background:#694b2c;color:#f8d99f; }
.lobby__top,.lobby__top strong { color:#ecd09d; }
.lobby__panel .main-button { margin-top:12px; }
.table-surface {
  min-height:380px;
  border:15px solid transparent;
  border-radius:clamp(24px,5vw,76px);
  background:
    radial-gradient(ellipse at 49% 41%,#3a6339 0%,#234b30 50%,#143925 88%,#112b1e 100%) padding-box,
    repeating-linear-gradient(92deg,#784725 0,#9b6233 13px,#633918 24px,#a36a3e 34px,#603817 46px,#8a532c 62px) border-box;
  box-shadow:
    0 0 0 2px #b98949,
    0 0 0 5px #492a15,
    0 11px 0 #28180d,
    0 24px 38px #0009,
    inset 0 0 0 3px #ceac72,
    inset 0 0 0 10px #351e115e,
    inset 0 0 55px #040e0866;
}
.table-surface::before { content:""; position:absolute; inset:9px; pointer-events:none; border:2px solid #c9a46b; border-radius:clamp(18px,5vw,66px); z-index:0; opacity:.8; }
.table-surface::after { inset:21px; border-radius:clamp(14px,4vw,58px); background:radial-gradient(ellipse at 32% 3%,#ffdda31b,transparent 60%); pointer-events:none; }
.table-surface__ring { inset:27px; border:1px solid rgba(241,209,139,.38); border-radius:clamp(14px,4vw,53px); }
.table-ornament { position:absolute; z-index:1; pointer-events:none; width:165px; height:100px; background:url('/ornament.svg') center/contain no-repeat; opacity:.95; filter:drop-shadow(0 1px 2px #2714077a); }
.table-ornament--tl { top:-7px; left:4px; }
.table-ornament--tr { top:-7px; right:4px; transform:scaleX(-1); }
.table-ornament--bl { bottom:-8px; left:4px; transform:scaleY(-1); }
.table-ornament--br { bottom:-8px; right:4px; transform:scale(-1); }
.table-center { min-height:245px; padding:5px 24px 19px; }
.table-center__label { font:700 11px Georgia,serif; letter-spacing:.24em; color:#f1d7a3; padding:0 28px; position:relative; }
.table-center__label::before,.table-center__label::after { content:"❧"; position:absolute; top:-6px; left:0; font-size:23px; color:#d8b879; }
.table-center__label::after { left:auto; right:0; transform:scaleX(-1); }
.table-center__cards {
  display:grid;
  width:min(840px,95%);
  max-width:840px;
  grid-template-columns:130px minmax(220px,1fr) 130px;
  grid-template-rows:1fr 1fr;
  grid-template-areas:"deck trick trump" "discard trick trump";
  align-items:center;
  justify-items:stretch;
  column-gap:24px;
  row-gap:16px;
}
.table-center__slot { flex:none; min-width:0; width:100%; gap:6px; }
.table-center__slot--deck { grid-area:deck; }
.table-center__slot--discard { grid-area:discard; }
.table-center__slot--trick {
  grid-area:trick; display:flex; align-items:center; justify-content:space-between;
  min-height:253px; align-self:stretch; padding:14px 10px;
  border:2px solid #d0b070; border-radius:41px;
  background:radial-gradient(ellipse,#42734a20,transparent 70%);
  box-shadow:0 0 0 5px #14382122,inset 0 0 10px #f4d2930c;
  position:relative;
}
.table-center__slot--trick::before,.table-center__slot--trick::after { content:"❧"; position:absolute; top:3px; left:50%; transform:translateX(-50%); font:26px Georgia,serif;color:#d9ba7d; }
.table-center__slot--trick::after { top:auto; bottom:2px; transform:translateX(-50%) rotate(180deg); }
.table-center__slot--trump { grid-area:trump; border:1px solid rgba(235,198,132,.6); border-radius:17px; min-height:170px; justify-content:center; padding:10px 7px; background:linear-gradient(150deg,#172b1bd4,#28371d9e); box-shadow:0 0 0 3px #bca4771a,inset 0 0 0 3px rgba(233,199,123,.16),0 8px 20px #0b180c6b; }
.trump-display { display:flex; align-items:center; flex-direction:column; gap:0; color:#f1e3b6; }
.trump-display strong { font:76px Georgia,serif; line-height:1.07; text-shadow:0 3px 10px #060f07; }
.trump-display--red strong { color:#e6a0a0; }
.trump-display__star { font:10px Georgia,serif; color:#cfae6f; }
.table-center__slot--deck .deck-button,.table-center__slot--discard .discard-stack { filter:drop-shadow(0 6px 4px #09150a70); }
.table-center__slot--deck .slot-heading,.table-center__slot--discard .slot-heading,.table-center__slot--trump .slot-heading { font-size:10px; font-weight:900; color:#f0d7a4; }
.table-center__slot--deck .deck-button--available { animation:deck-pulse 2.1s ease-in-out infinite; }
.player-dock { background:linear-gradient(165deg,#402a1b,#2e291c 37%,#213822 88%); border:5px solid #794e2c; outline:1px solid #b58b58; box-shadow:0 15px 25px #0007,inset 0 0 0 1px #dbb97b5a; border-radius:23px; padding:13px 16px; position:relative; }
.player-dock::before { content:"❧";position:absolute; top:-11px;left:50%;transform:translateX(-50%);font:24px Georgia,serif;color:#d7b372; }
.action-button,.main-button,.target-actions__buttons button { transition:filter .15s ease,transform .13s ease,box-shadow .15s ease; }
.action-button:active,.main-button:active,.target-actions__buttons button:active { transform:translateY(2px);box-shadow:inset 0 2px 7px #0005; }
.deck-button--available:focus-visible,.seat__card-button:focus-visible { outline:3px solid #fff3b0;outline-offset:4px; }
@media(min-width:960px) {
 .opponents { padding-top:19px; min-height:111px; }
 .table-center__slot--trick .trick-stack { min-height:135px; }
 .table-surface { flex:1; }
 .game-layout { gap:12px; }
 .player-dock { width:min(1240px,100%); }
}
@media(max-width:850px) {
 .table-ornament { width:110px; height:65px; opacity:.65; }
 .table-center__cards { column-gap:9px; grid-template-columns:100px minmax(150px,1fr) 100px; width:min(100%,570px); }
 .table-center__slot--trick { min-height:210px; }
}
@media(max-width:680px) and (orientation:portrait) {
 .table-surface {
  border-width:7px;
  border-radius:27px;
  min-height:340px;
  background:
    radial-gradient(ellipse at 52% 34%,#315f3a 0%,#20472e 65%,#163721 100%) padding-box,
    repeating-linear-gradient(96deg,#8b5930,#734421 18px,#a56c38 31px,#58391d 44px) border-box;
  box-shadow:0 0 0 1px #b98d53,0 4px 0 #3d2919,0 13px 20px #0009,inset 0 0 0 3px #d3ae72;
 }
 .table-surface::before { inset:5px; border-radius:19px; border-width:1px; }
 .table-surface__ring { inset:12px; border-radius:14px; }
 .table-ornament { width:65px; height:50px; opacity:.6; }
 .table-ornament--tl { left:-7px; top:-10px; }
 .table-ornament--tr { right:-7px; top:-10px; }
 .table-ornament--bl,.table-ornament--br { display:none; }
 .opponents { justify-content:flex-start; padding:12px 4px 2px; min-height:92px; }
 .table-center { padding:6px 4px 13px; min-height:210px; gap:7px; }
 .table-center__label { font-size:9px; padding:0 18px; }
 .table-center__label::before,.table-center__label::after { font-size:17px; top:-3px; }
 .table-center__cards { grid-template-columns:66px minmax(0,1fr) 67px; column-gap:5px; row-gap:9px; width:min(100%,370px); grid-template-rows:87px 87px; }
 .table-center__slot { gap:3px; }
 .table-center__slot--trick { min-height:166px; padding:7px 1px; border-radius:25px; border-width:1px; }
 .table-center__slot--trick::before,.table-center__slot--trick::after { font-size:15px; }
 .trick-stack { min-height:100px; }
 .table-center__slot--trump { min-height:116px; padding:3px; border-radius:12px; }
 .trump-display strong { font-size:46px; }
 .trump-display__star { font-size:8px; }
 .slot-heading { font-size:8px!important; letter-spacing:.02em; }
 .slot-count { font-size:8px; }
 .table-center__slot--deck :deep(.playing-card),.table-center__slot--discard :deep(.playing-card) { --width:55px; }
 .empty-slot { width:55px; }
 .table-center__slot--trick .empty-slot { width:58px; }
 .player-dock { border-width:3px; border-radius:13px; padding:7px 5px; }
 .player-dock::before { display:none; }
 .player-dock .trump { display:none; }
 .player-dock__buttons { justify-content:center; }
 .player-dock__buttons .action-button { min-height:37px; }
 .drawer-banner { border-radius:8px; }
 .game-layout { gap:6px; }
}
@media(max-width:360px) and (orientation:portrait) {
 .table-center__cards { grid-template-columns:58px minmax(0,1fr) 60px; }
 .table-center__slot--deck :deep(.playing-card),.table-center__slot--discard :deep(.playing-card) { --width:49px; }
 .trump-display strong { font-size:41px; }
 .table-center__slot--trick .trick-stack { min-height:92px; }
}
@media(max-height:600px) and (orientation:landscape) {
 .game-layout { overflow-y:auto; }
 .table-surface { flex:0 0 auto; min-height:330px; }
}
@media(prefers-reduced-motion:reduce) {
 .table-center__slot--deck .deck-button--available { animation:none; }
 .action-button,.main-button,.target-actions__buttons button { transition:none; }
}

</style>
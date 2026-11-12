<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useGameStore } from './stores/game';
import CardComponent from './components/CardComponent.vue';
import PlayerSeat from './components/PlayerSeat.vue';
import HandFan from './components/HandFan.vue';
import { mountTelegramViewport } from './telegramViewport';
import type { Card, Suit } from '@shared/types';

type Flight = { card: Card; hidden: boolean };
type SeatSlot = 'left' | 'top-left' | 'top-center' | 'top-right' | 'right';
type DealEvent = { card: Card; target: string; faceUp: boolean };

const game = useGameStore();
const name = ref('');
const room = ref('pidor-1');
const joined = ref(false);
const soundOn = ref(localStorage.getItem('pidor:sound') !== 'off');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const selectedPenalty = ref<Card | null>(null);
const animationLocked = ref(false);
const deckRef = ref<HTMLElement | null>(null);
const flightRef = ref<HTMLElement | null>(null);
const flight = ref<Flight | null>(null);
const hiddenIds = ref<Set<string>>(new Set());
const protectedIds = ref<Set<string>>(new Set());
const activeFlightId = ref<string | null>(null);
const deckGestureId = ref<number | null>(null);
const deckGestureHeld = ref(false);
const activeDragging = ref(false);
const dragPoint = ref({ x: 0, y: 0 });
const dragTarget = ref<string | null>(null);
const pending = ref<string | null>(null);
const alertText = ref('');
let toastTimeout: ReturnType<typeof setTimeout> | undefined;
let pendingTimeout: ReturnType<typeof setTimeout> | undefined;
let cleanupTelegram: (() => void) | undefined;
let audioContext: AudioContext | null = null;
let dealRun = 0;

const state = computed(() => game.gameState);
const me = computed(() => state.value?.players.find(p => p.id === game.socket?.id));
const isMyTurn = computed(() => state.value?.players[state.value.turnIndex]?.id === game.socket?.id);
const currentPhase = computed(() => state.value?.phase || '');
const phaseText = computed(() => {
  const labels: Record<string, string> = {
    LOBBY: 'Ожидание', DEALING: 'Раскладка', PENALTY_DISTRIBUTION: 'Похуёвые', MAIN_GAME: 'Основная игра', ENDED: 'Финал',
  };
  return labels[currentPhase.value] || '';
});
const others = computed(() => {
  if (!state.value || !me.value) return [];
  const p = state.value.players;
  const index = p.findIndex(x => x.id === me.value?.id);
  return [...p.slice(index + 1), ...p.slice(0, index)];
});
const seatSlots: Record<number, SeatSlot[]> = {
  0: [], 1: ['top-center'], 2: ['top-left','top-right'],
  3: ['left','top-center','right'], 4: ['left','top-left','top-right','right'],
  5: ['left','top-left','top-center','top-right','right'],
};
const seats = computed(() => others.value.map((player, i) => ({
  player, slot: (seatSlots[others.value.length] ?? seatSlots[5]!)[i],
})));
const canDraw = computed(() => currentPhase.value === 'DEALING' && isMyTurn.value && !state.value?.activeCard && !animationLocked.value && !pending.value);
const canPlay = computed(() => currentPhase.value === 'MAIN_GAME' && isMyTurn.value && !animationLocked.value && !pending.value);
const active = computed(() => state.value?.activeCard);
const trumpSymbol: Record<Suit, string> = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const isRedTrump = computed(() => state.value?.trumpSuit === 'diamonds' || state.value?.trumpSuit === 'hearts');
const penaltyPlayerName = computed(() => state.value?.players.find(p => p.id === game.lastPenalty?.playerId)?.name || 'Игрок');
const nextPlayer = computed(() => {
  const players = state.value?.players;
  if (!players?.length) return null;
  return players[(state.value!.turnIndex + 1) % players.length];
});
const trickPosition = computed(() => {
  const slot = seats.value.find(x => x.player.id === nextPlayer.value?.id)?.slot ?? 'bottom';
  const coords: Record<string, { left: string; top: string }> = {
    left: { left: '23%', top: '45%' },
    'top-left': { left: '32%', top: '32%' },
    'top-center': { left: '50%', top: '31%' },
    'top-right': { left: '68%', top: '32%' },
    right: { left: '76%', top: '45%' },
    bottom: { left: '50%', top: '69%' },
  };
  return coords[slot] || coords.bottom;
});

function tone(kind: 'draw' | 'drop' | 'turn' | 'select' | 'penalty') {
  if (!soundOn.value) return;
  try {
    audioContext ??= new AudioContext();
    if (audioContext.state === 'suspended') void audioContext.resume();
    const t = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const f = { draw: 370, drop: 235, turn: 510, select: 630, penalty: 190 }[kind];
    oscillator.type = kind === 'penalty' ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(f, t);
    oscillator.frequency.exponentialRampToValueAtTime(f * .78, t + .09);
    gain.gain.setValueAtTime(.0001, t);
    gain.gain.exponentialRampToValueAtTime(kind === 'select' ? .006 : .022, t + .01);
    gain.gain.exponentialRampToValueAtTime(.0001, t + .13);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(t);
    oscillator.stop(t + .14);
  } catch { /* optional sound */ }
}
function toggleSound() {
  soundOn.value = !soundOn.value;
  localStorage.setItem('pidor:sound', soundOn.value ? 'on' : 'off');
  tone('select');
}
function showToast(text: string) {
  clearTimeout(toastTimeout);
  alertText.value = text;
  toastTimeout = setTimeout(() => { alertText.value = ''; }, 2000);
}
function join() {
  const playerName = name.value.trim();
  if (!playerName || !room.value.trim()) return;
  game.joinRoom(playerName, room.value.trim());
  joined.value = true;
  tone('turn');
}
function dispatchOnce(key: string, send: () => void) {
  if (pending.value || animationLocked.value) return;
  pending.value = key;
  send();
  clearTimeout(pendingTimeout);
  pendingTimeout = setTimeout(() => { pending.value = null; }, 800);
}
function playCard(card: Card) {
  if (!canPlay.value) return;
  tone('drop');
  dispatchOnce('play:' + card.id, () => game.playCard(card.id));
}
function placeCard(targetId: string) {
  if (!active.value || !isMyTurn.value || animationLocked.value) return;
  tone('drop');
  dispatchOnce('place:' + active.value.card.id, () => game.placeActiveCard(targetId));
  activeDragging.value = false;
  dragTarget.value = null;
}
function handleSeatCard({ card, ownerId }: { card: Card; ownerId: string }) {
  if (currentPhase.value === 'DEALING') {
    if (active.value) return placeCard(ownerId);
    if (!isMyTurn.value || ownerId !== me.value?.id || protectedIds.value.has(card.id)) return;
    dispatchOnce('take:' + card.id, () => game.takeFromPile(card.id));
  } else if (currentPhase.value === 'PENALTY_DISTRIBUTION' && ownerId === me.value?.id) {
    selectedPenalty.value = card;
    tone('select');
  }
}
function handleSeatClick(targetId: string) {
  if (currentPhase.value === 'DEALING' && active.value) placeCard(targetId);
  if (currentPhase.value === 'PENALTY_DISTRIBUTION' && selectedPenalty.value) {
    const card = selectedPenalty.value;
    dispatchOnce('penalty:' + card.id, () => game.givePenaltyCard(card.id, targetId));
    selectedPenalty.value = null;
  }
}
function drawDeck() {
  if (!canDraw.value) return;
  tone('draw');
  dispatchOnce('draw', () => game.drawCardFromDeck());
}
function onDeckDown(e: PointerEvent) {
  if (!canDraw.value) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  deckGestureId.value = e.pointerId;
  deckGestureHeld.value = true;
  dragPoint.value = { x: e.clientX, y: e.clientY };
  drawDeck();
  e.preventDefault();
}
function onActiveDown(e: PointerEvent) {
  if (!active.value || !isMyTurn.value || animationLocked.value) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  deckGestureId.value = e.pointerId;
  deckGestureHeld.value = false;
  activeDragging.value = true;
  dragPoint.value = { x: e.clientX, y: e.clientY };
  e.preventDefault();
}
function movePointer(e: PointerEvent) {
  if (deckGestureId.value !== e.pointerId) return;
  dragPoint.value = { x: e.clientX, y: e.clientY };
  if (!activeDragging.value && deckGestureHeld.value && active.value && isMyTurn.value && !animationLocked.value) activeDragging.value = true;
  if (activeDragging.value) {
    dragTarget.value = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-seat-id]')?.dataset.seatId ?? null;
  }
}
function endPointer(e: PointerEvent) {
  if (e.pointerId !== deckGestureId.value) return;
  if (activeDragging.value && dragTarget.value) placeCard(dragTarget.value);
  deckGestureHeld.value = false;
  deckGestureId.value = null;
  activeDragging.value = false;
  dragTarget.value = null;
}
function getCenter(element: Element | null, fallback: { x: number; y: number }) {
  if (!element) return fallback;
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2 - 42, y: rect.top + rect.height / 2 - 59 };
}
function deckPoint() {
  return getCenter(deckRef.value?.querySelector('.playing-card') ?? deckRef.value, {
    x: window.innerWidth / 2 - 42, y: window.innerHeight / 2 - 59,
  });
}
async function flyCard(card: Card, targetId: string | null, faceUp: boolean) {
  const from = deckPoint();
  const target = targetId
    ? document.querySelector('[data-seat-id="' + CSS.escape(targetId) + '"] .seat__cards')
    : document.querySelector('.table__active-anchor');
  const to = getCenter(target, { x: window.innerWidth / 2 - 42, y: window.innerHeight / 2 - 59 });
  flight.value = { card, hidden: true };
  await nextTick();
  const element = flightRef.value;
  if (!element) return;
  const ms = reducedMotion ? 70 : 280;
  const motion = element.animate([
    { transform: 'translate(' + from.x + 'px,' + from.y + 'px) scale(.87) rotate(-5deg)', filter: 'drop-shadow(0 4px 4px #0004)' },
    { transform: 'translate(' + ((from.x + to.x) / 2) + 'px,' + ((from.y + to.y) / 2 - 30) + 'px) scale(1.09) rotate(2deg)', filter: 'drop-shadow(0 14px 10px #0008)', offset: .48 },
    { transform: 'translate(' + to.x + 'px,' + to.y + 'px) scale(.59) rotate(0deg)', filter: 'drop-shadow(0 4px 4px #0004)' },
  ], { duration: ms, easing: 'cubic-bezier(.2,.7,.25,1)', fill: 'forwards' });
  if (faceUp) {
    const body = element.querySelector<HTMLElement>('.card-flight__body');
    body?.animate([
      { transform: 'rotateY(0deg)' },
      { transform: 'rotateY(88deg)', offset: .5 },
      { transform: 'rotateY(0deg)' },
    ], { duration: ms, fill: 'forwards' });
    setTimeout(() => { if (flight.value?.card.id === card.id) flight.value = { card, hidden: false }; }, ms / 2);
  }
  try { await motion.finished; } catch { /* interrupted */ }
  flight.value = null;
}
async function replayInitialDeal(cards: DealEvent[]) {
  const token = ++dealRun;
  animationLocked.value = true;
  hiddenIds.value = new Set(cards.map(e => e.card.id));
  await nextTick();
  for (const item of cards) {
    if (token !== dealRun || currentPhase.value !== 'DEALING') break;
    await flyCard(item.card, item.target, item.faceUp);
    hiddenIds.value = new Set([...hiddenIds.value].filter(id => id !== item.card.id));
    tone('drop');
    if (!reducedMotion) await new Promise(resolve => setTimeout(resolve, 38));
  }
  hiddenIds.value = new Set();
  animationLocked.value = false;
}

watch(state, (value, old) => {
  if (!value) return;
  // Initial server snapshot is authoritative: replay actual card IDs in round-robin order.
  if (value.phase === 'DEALING' && old?.phase !== 'DEALING') {
    const rounds = Math.max(...value.players.map(p => p.stumps.length), 0);
    const sequence: DealEvent[] = [];
    const locked = new Set<string>();
    for (let round = 0; round < rounds; round++) {
      for (const player of value.players) {
        const card = player.stumps[round];
        if (!card) continue;
        sequence.push({ card, target: player.id, faceUp: round === (player.stumps.length >= 3 ? 2 : 0) });
        if (round < (player.stumps.length >= 3 ? 3 : 1)) locked.add(card.id);
      }
    }
    protectedIds.value = locked;
    if (sequence.length) void replayInitialDeal(sequence);
  }
  if (value.activeCard?.card.id && value.activeCard.card.id !== old?.activeCard?.card.id && !deckGestureHeld.value) {
    activeFlightId.value = value.activeCard.card.id;
    void flyCard(value.activeCard.card, null, true).finally(() => {
      activeFlightId.value = null;
    });
  }
  if (old?.turnIndex !== value.turnIndex && value.phase !== 'LOBBY') tone('turn');
  if (pending.value && old?.activeCard?.card.id !== value.activeCard?.card.id) pending.value = null;
  if (pending.value && value.phase !== old?.phase) pending.value = null;
}, { flush: 'sync' });

watch(() => game.lastPenalty, penalty => {
  if (!penalty) return;
  showToast('☠ ' + penaltyPlayerName.value + ' · ' + penalty.reason);
  tone('penalty');
});

onMounted(() => {
  cleanupTelegram = mountTelegramViewport();
  window.addEventListener('pointermove', movePointer, { passive: true });
  window.addEventListener('pointerup', endPointer, { passive: true });
  window.addEventListener('pointercancel', endPointer, { passive: true });
  game.connect();
});
onBeforeUnmount(() => {
  ++dealRun;
  clearTimeout(toastTimeout);
  clearTimeout(pendingTimeout);
  cleanupTelegram?.();
  window.removeEventListener('pointermove', movePointer);
  window.removeEventListener('pointerup', endPointer);
  window.removeEventListener('pointercancel', endPointer);
  void audioContext?.close();
});
</script>

<template>
  <main class="app-shell">
    <header class="game-bar">
      <div>
        <div class="brand">PIDOR <strong>ONLINE</strong></div>
        <div class="game-bar__meta">{{ joined ? phaseText + ' · ' + room : 'Карточная игра' }}</div>
      </div>
      <div class="game-bar__actions">
        <div class="stars-placeholder" title="Игровые звёзды появятся позже">★ 0 <small>скоро</small></div>
        <button class="icon-button" type="button" :aria-label="soundOn ? 'Выключить звук' : 'Включить звук'" @click="toggleSound">{{ soundOn ? '♫' : '♪̸' }}</button>
      </div>
    </header>

    <section v-if="!joined" class="lobby">
      <form class="lobby__panel" @submit.prevent="join">
        <h1 class="lobby__title">PIDOR ONLINE</h1>
        <p class="lobby__subtitle">Свои правила. Свой стол.</p>
        <input class="lobby__field" v-model="name" maxlength="26" autocomplete="nickname" placeholder="Твоё имя" required aria-label="Имя игрока" />
        <input class="lobby__field" v-model="room" maxlength="48" placeholder="Код стола" required aria-label="Код стола" />
        <button class="lobby__button" type="submit">Играть с друзьями</button>
        <div class="lobby__subtitle">★ Ставки на звёзды появятся позже</div>
      </form>
    </section>

    <section v-else-if="state?.phase === 'LOBBY'" class="lobby">
      <div class="lobby__panel">
        <div class="lobby__title">За столом</div>
        <div class="lobby__people">
          <span v-for="p in state.players" :key="p.id" class="lobby__person">◆ {{ p.name }}</span>
        </div>
        <button v-if="state.players.length >= 2" class="lobby__button" @click="game.startGame()">Начать партию</button>
        <div v-else class="lobby__subtitle">Ожидаем второго игрока</div>
      </div>
    </section>

    <section v-else-if="state" class="game-viewport">
      <div class="table">
        <div
          v-for="entry in seats"
          :key="entry.player.id"
          class="table__seat"
          :class="['table__seat--' + entry.slot, { 'table__seat--target': dragTarget === entry.player.id }]"
        >
          <PlayerSeat
            :player="entry.player"
            :phase="state.phase"
            :is-turn="state.players[state.turnIndex]?.id === entry.player.id"
            :hidden-card-ids="hiddenIds"
            @click="handleSeatClick(entry.player.id)"
            @card-click="handleSeatCard"
          />
        </div>

        <div v-if="me && state.phase === 'DEALING'" class="table__seat table__seat--self">
          <PlayerSeat
            :player="me"
            :phase="state.phase"
            :is-me="true"
            :is-turn="isMyTurn"
            :hidden-card-ids="hiddenIds"
            @click="handleSeatClick(me.id)"
            @card-click="handleSeatCard"
          />
        </div>

        <div v-if="state.deck.length" ref="deckRef" role="button" tabindex="0"
          class="table__deck" :class="{ 'table__deck--turn': canDraw }"
          :aria-label="'Взять карту из колоды. Осталось ' + state.deck.length"
          @pointerdown="onDeckDown"
          @keydown.enter.prevent="drawDeck"
          @keydown.space.prevent="drawDeck"
        >
          <CardComponent hidden />
          <span class="table__deck-count">{{ state.deck.length }}</span>
        </div>
        <div v-if="state.phase === 'MAIN_GAME' && state.trumpSuit" class="table__trump" :class="{ 'table__trump--red': isRedTrump }">
          Козырь <b>{{ trumpSymbol[state.trumpSuit] }}</b>
        </div>

        <div v-if="state.discardPile.length" class="table__discard">
          <CardComponent hidden small />
          <div class="table__discard-num">{{ state.discardPile.length }}</div>
        </div>

        <div data-drop-zone="trick" class="table__play-target" :class="{ 'table__play-target--enabled': canPlay }"></div>
        <div class="table__trick" :style="state.phase === 'MAIN_GAME' ? trickPosition : {}">
          <div v-for="(card,i) in state.currentTrick" :key="card.id" :style="{ '--trick-rot': (i * 6 - 4) + 'deg', '--trick-x': (i * 8) + 'px', '--trick-y': (i * -4) + 'px' }">
            <CardComponent :card="card" small />
          </div>
        </div>
        <div class="table__active-anchor"></div>
        <div v-if="active && activeFlightId !== active.card.id"
          class="table__active" :class="{ 'table__active--drag': activeDragging }"
          :style="activeDragging ? { '--drag-x': dragPoint.x + 'px', '--drag-y': dragPoint.y + 'px' } : {}"
          @pointerdown="onActiveDown"
        >
          <CardComponent :card="active.card" />
        </div>
        <div v-if="active && !activeDragging && isMyTurn && state.phase === 'DEALING'" class="table__target-hint">
          Перенеси карту на игрока
        </div>
      </div>

      <footer class="hand-area">
        <div class="hand-area__actions">
          <button v-if="state.phase === 'MAIN_GAME' && isMyTurn && state.currentTrick.length" class="action-pill" @click="game.takeTrick()">Забрать</button>
          <button v-if="me && !me.hand.length && me.stumps.length && state.phase === 'MAIN_GAME'" class="action-pill" @click="game.takeStumps()">Беру пеньки</button>
          <button v-if="me && !me.hand.length && !me.stumps.length && state.phase === 'MAIN_GAME'" class="action-pill action-pill--quiet" @click="game.exitGame()">Выйти</button>
        </div>
        <div v-if="me" class="hand-area__label">{{ me.name }} · {{ me.hand.length }} карт</div>
        <HandFan v-if="me && ['MAIN_GAME', 'PENALTY_DISTRIBUTION'].includes(state.phase)" :cards="me.hand"
          :disabled="state.phase === 'MAIN_GAME' ? !canPlay : animationLocked"
          @play="state.phase === 'MAIN_GAME' ? playCard($event) : (selectedPenalty = $event)"
          @select="tone('select')"
        />
      </footer>
    </section>

    <Transition name="toast">
      <div v-if="alertText" class="toast" role="status">{{ alertText }}</div>
    </Transition>
    <div v-if="flight" ref="flightRef" class="card-flight">
      <div class="card-flight__body"><CardComponent :card="flight.card" :hidden="flight.hidden" /></div>
    </div>
  </main>
</template>

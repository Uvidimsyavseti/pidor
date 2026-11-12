<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useGameStore } from './stores/game';
import CardComponent from './components/CardComponent.vue';
import PlayerSeat from './components/PlayerSeat.vue';
import HandFan from './components/HandFan.vue';
import { mountTelegramViewport, requestTelegramFullscreen } from './telegramViewport';
import type { Card, Suit } from '@shared/types';

type Flight = { card: Card; hidden: boolean };
type SeatSlot = 'left' | 'top-left' | 'top-center' | 'top-right' | 'right';
type DealEvent = { card: Card; target: string; faceUp: boolean };

const game = useGameStore();
const name = ref('');
const room = ref('pidor-1');
const joined = ref(false);
type MatchRecord = { room: string; at: number; players: number; penalties: number; result: 'finished' | 'last' };
const statsKey = 'pidor:profile:v1';
function loadHistory(): MatchRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(statsKey) || '[]') as unknown;
    return Array.isArray(value) ? value.filter((v): v is MatchRecord =>
      typeof v === 'object' && v !== null && typeof v.at === 'number' &&
      typeof v.room === 'string' && (v.result === 'finished' || v.result === 'last')).slice(0, 30) : [];
  } catch { return []; }
}
const history = ref<MatchRecord[]>(loadHistory());
const showProfile = ref(false);
const totalMatches = computed(() => history.value.length);
const survivedMatches = computed(() => history.value.filter(m => m.result === 'finished').length);
const totalPenalties = computed(() => history.value.reduce((sum, m) => sum + m.penalties, 0));
let recordedEndKey = '';
function recordFinishedMatch() {
  if (!state.value || state.value.phase !== 'ENDED' || !me.value || !game.roomId) return;
  const key = 'pidor:recorded:' + game.roomId + ':' + game.playerId;
  if (recordedEndKey === key || localStorage.getItem(key)) return;
  recordedEndKey = key;
  const entry: MatchRecord = {
    room: game.roomId, at: Date.now(), players: state.value.players.length,
    penalties: me.value.penalties, result: me.value.onDuty ? 'last' : 'finished',
  };
  history.value = [entry, ...history.value].slice(0, 30);
  localStorage.setItem(statsKey, JSON.stringify(history.value));
  localStorage.setItem(key, '1');
}
const underlaid = ref(true);
const bots = ref(3);
const uiTab = ref<'free' | 'create' | 'code' | 'bots'>('free');
const publicRoom = ref(true);
const tableTitle = ref('Стол у камина');
const selectedAccused = ref<string | null>(null);
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
const soundOn = ref(localStorage.getItem('pidor:sound') !== 'off');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const selectedPenalty = ref<Card | null>(null);
const animationLocked = ref(false);
const deckRef = ref<HTMLElement | null>(null);
const flightRef = ref<HTMLElement | null>(null);
const flight = ref<Flight | null>(null);
const flightOrigin = ref({ x: -200, y: -200 });
const vfx = ref<{ id: number; x: number; y: number; kind: 'draw' | 'play' | 'penalty' } | null>(null);
let vfxSerial = 0;
function burst(kind: 'draw' | 'play' | 'penalty', x: number, y: number) {
  if (reducedMotion) return;
  const id = ++vfxSerial;
  vfx.value = { id, x, y, kind };
  setTimeout(() => { if (vfx.value?.id === id) vfx.value = null; }, 530);
}
const hiddenIds = ref<Set<string>>(new Set());
const protectedIds = ref<Set<string>>(new Set());
const activeFlightId = ref<string | null>(null);
const deckGestureId = ref<number | null>(null);
const deckGestureHeld = ref(false);
const activeDragging = ref(false);
const dragPoint = ref({ x: 0, y: 0 });
const dragTarget = ref<string | null>(null);
const fanHover = ref(false);
const pending = ref<string | null>(null);
const alertText = ref('');
let toastTimeout: ReturnType<typeof setTimeout> | undefined;
let pendingTimeout: ReturnType<typeof setTimeout> | undefined;
let cleanupTelegram: (() => void) | undefined;
let audioContext: AudioContext | null = null;
let dealRun = 0;

const state = computed(() => game.gameState);
const me = computed(() => state.value?.players.find(p => p.id === game.playerId));
const isMyTurn = computed(() => state.value?.players[state.value.turnIndex]?.id === game.playerId);
const currentPhase = computed(() => state.value?.phase || '');
const phaseText = computed(() => {
  const labels: Record<string, string> = {
    LOBBY: 'Ожидание', DEALING: 'Раскладка', PENALTY_REVIEW: 'Проверка', PENALTY_DISTRIBUTION: 'Похуёвые', MAIN_GAME: 'Основная игра', ENDED: 'Финал',
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
const canDraw = computed(() => currentPhase.value === 'DEALING' && isMyTurn.value && !state.value?.activeCard && !animationLocked.value && !pending.value && !(state.value?.initialDealEndsAt && clock.value < state.value.initialDealEndsAt));
const canPlay = computed(() => currentPhase.value === 'MAIN_GAME' && isMyTurn.value && !animationLocked.value && !pending.value);
const reviewSeconds = computed(() => Math.max(0, Math.ceil(((state.value?.reviewDeadlineAt || clock.value) - clock.value) / 1000)));
const loser = computed(() => state.value?.players.find(player => player.onDuty) || null);
const handLabel = computed(() => {
  const view = state.value;
  const own = me.value;
  if (!view || !own) return '';
  const recipient = view.pendingPenaltyTurn?.receiverId;
  if (view.phase === 'PENALTY_DISTRIBUTION' && view.pendingPenaltyTurn?.giverId === game.playerId) {
    return 'Передай карту: ' + (view.players.find(player => player.id === recipient)?.name || 'игроку');
  }
  return own.name + ' · ' + own.hand.length + ' карт';
});
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
  const slot = seats.value.find(x => x.player.id === (state.value?.trickTargetId || nextPlayer.value?.id))?.slot ?? 'bottom';
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
function joinRoom(id: string, opts: { mode?: 'friends' | 'bot'; botCount?: number; underlaidCards?: boolean } = {}) {
  if (!name.value.trim()) { showToast('Введи имя'); return; }
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id)) { showToast('Неверный код комнаты'); return; }
  room.value = id;
  requestTelegramFullscreen();
  game.joinRoom(name.value.trim(), id, opts);
  joined.value = true;
  localStorage.setItem('pidor:name', name.value.trim());
  window.history.replaceState(null, '', '?room=' + encodeURIComponent(id));
  tone('turn');
}
function join() { joinRoom(room.value.trim(), { mode: 'friends', underlaidCards: underlaid.value }); }
function playBots() {
  const id = 'bot_' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  joinRoom(id, { mode: 'bot', botCount: bots.value, underlaidCards: underlaid.value });
}
async function createRoom() {
  if (!name.value.trim()) { showToast('Введи имя'); return; }
  const table = await game.createTable({
    title: tableTitle.value, visibility: publicRoom.value ? 'public' : 'private',
    underlaidCards: underlaid.value,
  });
  if (!table) { showToast(game.lastError || 'Ошибка создания стола'); return; }
  joinRoom(table.id, { mode: 'friends', underlaidCards: table.underlaidCards });
}
async function inviteFriend() {
  const link = new URL(location.href);
  link.searchParams.set('room', room.value);
  const message = 'Сыграем в PIDOR ONLINE? ' + link.toString();
  try {
    if (navigator.share) await navigator.share({ title: 'PIDOR ONLINE', text: message, url: link.toString() });
    else if (navigator.clipboard) { await navigator.clipboard.writeText(message); showToast('Ссылка скопирована'); }
    else showToast('Код стола: ' + room.value);
  } catch { /* Cancelled share: no action needed. */ }
}
function backToLobby() {
  game.disconnect();
  joined.value = false;
  selectedPenalty.value = null;
  window.history.replaceState(null, '', location.pathname);
  void game.fetchTables();
}
function accuseSelected() {
  if (!selectedAccused.value) return showToast('Выбери подозреваемого');
  const id = selectedAccused.value;
  showToast('☠ ПОХУЁВАЯ!');
  tone('penalty');
  burst('penalty', window.innerWidth / 2, window.innerHeight * .44);
  dispatchOnce('accuse:' + id, () => game.accusePlayer(id));
  selectedAccused.value = null;
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
  if (!active.value || !isMyTurn.value || (animationLocked.value && currentPhase.value !== 'DEALING')) return;
  tone('drop');
  burst('play', dragPoint.value.x || window.innerWidth / 2, dragPoint.value.y || window.innerHeight / 2);
  dispatchOnce('place:' + active.value.card.id, () => game.placeActiveCard(targetId));
  activeDragging.value = false;
  dragTarget.value = null;
}
function handleSeatCard({ card, ownerId }: { card: Card; ownerId: string }) {
  if (currentPhase.value === 'DEALING') {
    if (active.value) return placeCard(ownerId);
    if (!isMyTurn.value || ownerId !== me.value?.id || protectedIds.value.has(card.id) || (me.value?.stumps.length || 0) <= (state.value?.underlaidCards === false ? 1 : 3)) return;
    dispatchOnce('take:' + card.id, () => game.takeFromPile(card.id));
  } else if (currentPhase.value === 'PENALTY_DISTRIBUTION' && ownerId === me.value?.id) {
    selectedPenalty.value = card;
    tone('select');
  }
}
function givePenalty(card: Card, receiverId: string) {
  if (currentPhase.value !== 'PENALTY_DISTRIBUTION') return;
  const turn = state.value?.pendingPenaltyTurn;
  if (turn?.giverId !== game.playerId || turn.receiverId !== receiverId) {
    showToast('Сейчас карта предназначена другому игроку');
    return;
  }
  dispatchOnce('penalty:' + card.id, () => game.givePenaltyCard(card.id, receiverId));
  selectedPenalty.value = null;
  tone('drop');
}
function handleSeatClick(targetId: string) {
  if (currentPhase.value === 'DEALING' && active.value) { placeCard(targetId); return; }
  if (currentPhase.value === 'PENALTY_DISTRIBUTION' && selectedPenalty.value) {
    givePenalty(selectedPenalty.value, targetId);
    return;
  }
  if (targetId !== game.playerId) selectedAccused.value = targetId;
}
function drawDeck() {
  if (!canDraw.value) return;
  tone('draw');
  dispatchOnce('draw', () => game.drawCardFromDeck());
}
function onDeckDown(e: PointerEvent) {
  if (!canDraw.value || active.value) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  // Drawing is a single deliberate tap. Do not begin a drag before the
  // server has actually assigned a card to this player.
  deckGestureId.value = null;
  deckGestureHeld.value = false;
  activeDragging.value = false;
  dragTarget.value = null;
  drawDeck();
  e.preventDefault();
}
function onActiveDown(e: PointerEvent) {
  if (!active.value || !isMyTurn.value || (animationLocked.value && currentPhase.value !== 'DEALING')) return;
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
  // Dragging starts on the revealed active card, never on the deck.
  if (activeDragging.value) {
    dragTarget.value = document.elementsFromPoint(e.clientX, e.clientY)
      .map(el => (el as HTMLElement).closest<HTMLElement>('[data-seat-id]'))
      .find((seat): seat is HTMLElement => Boolean(seat))?.dataset.seatId ?? null;
  }
}
function endPointer(e: PointerEvent) {
  if (e.pointerId !== deckGestureId.value) return;
  if (activeDragging.value) {
    const seat = document.elementsFromPoint(e.clientX, e.clientY)
      .map(el => (el as HTMLElement).closest<HTMLElement>('[data-seat-id]'))
      .find((el): el is HTMLElement => Boolean(el));
    const target = dragTarget.value || seat?.dataset.seatId;
    if (target) placeCard(target);
    else if (active.value) showToast('Отпусти карту на игроке или нажми на его карты');
  }
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
let flightQueue: Promise<void> = Promise.resolve();
function enqueueFlight(card: Card, targetId: string | null, faceUp: boolean, originSeatId?: string): Promise<void> {
  const next = flightQueue.catch(() => {}).then(() => flyCard(card, targetId, faceUp, originSeatId));
  flightQueue = next.catch(() => {});
  return next;
}
async function flyCard(card: Card, targetId: string | null, faceUp: boolean, originSeatId?: string) {
  const from = originSeatId ? getCenter(document.querySelector('[data-seat-id="' + CSS.escape(originSeatId) + '"] .seat__cards'), deckPoint()) : deckPoint();
  const target = targetId
    ? document.querySelector('[data-seat-id="' + CSS.escape(targetId) + '"] .seat__cards')
    : document.querySelector('.table__active-anchor');
  const to = getCenter(target, { x: window.innerWidth / 2 - 42, y: window.innerHeight / 2 - 59 });
  // Match the real card size at both ends; never shrink to a hard-coded .59.
  const sourceCard = originSeatId
    ? document.querySelector('[data-seat-id="' + CSS.escape(originSeatId) + '"] .playing-card')
    : deckRef.value?.querySelector('.playing-card');
  const targetCard = targetId
    ? document.querySelector('[data-seat-id="' + CSS.escape(targetId) + '"] .playing-card')
    : document.querySelector('.table__active .playing-card');
  const sourceScale = (sourceCard?.getBoundingClientRect().width || 84) / 84;
  const targetScale = (targetCard?.getBoundingClientRect().width || (targetId ? 54 : 84)) / 84;
  flightOrigin.value = from;
  flight.value = { card, hidden: true };
  await nextTick();
  const element = flightRef.value;
  if (!element) { flight.value = null; return; }
  const ms = reducedMotion ? 70 : (targetId ? 390 : 490);
  // A card moves along a shallow arc with a continuously interpolated size.
  // Both endpoints match the real DOM card, so no scale pop on landing.
  const start = Math.max(.3, sourceScale);
  const end = Math.max(.3, targetScale);
  const mid = start + (end - start) * .52;
  const arc = reducedMotion ? 0 : Math.min(34, Math.hypot(to.x - from.x, to.y - from.y) * .09);
  const at = (x: number, y: number, scale: number, rotation: number) =>
    `translate(${x}px, ${y}px) scale(${scale}) rotate(${rotation}deg)`;
  element.style.transform = at(from.x, from.y, start, 0);
  const motion = element.animate([
    { transform: at(from.x, from.y, start, 0), offset: 0 },
    { transform: at(from.x + (to.x - from.x) * .52, from.y + (to.y - from.y) * .52 - arc, mid, 2), offset: .52 },
    { transform: at(to.x, to.y, end, 0), offset: 1 },
  ], { duration: ms, easing: 'cubic-bezier(.35,0,.18,1)', fill: 'forwards' });
  let flipTimer: number | undefined;
  let flipMotion: Animation | undefined;
  if (faceUp) {
    const body = element.querySelector<HTMLElement>('.card-flight__body');
    flipMotion = body?.animate([
      { transform: 'rotateY(0deg)', offset: 0 },
      { transform: 'rotateY(89deg)', offset: .5 },
      { transform: 'rotateY(0deg)', offset: 1 },
    ], { duration: ms * .64, delay: ms * .14, easing: 'ease-in-out', fill: 'forwards' });
    // Swap the texture only while the same card is edge-on.
    flipTimer = window.setTimeout(() => {
      if (flight.value?.card.id === card.id) flight.value = { card, hidden: false };
    }, ms * .46);
  }
  try { await motion.finished; } catch { /* interrupted by navigation */ }
  if (flipTimer !== undefined) clearTimeout(flipTimer);
  if (faceUp && flight.value?.card.id === card.id) flight.value = { card, hidden: false };
  flipMotion?.cancel();
  // Keep the final frame stable until Vue has painted the destination card.
  await nextTick();
  burst(targetId ? 'draw' : 'play', to.x + 42, to.y + 59);
  flight.value = null;
}
async function replayInitialDeal(cards: DealEvent[]) {
  const token = ++dealRun;
  animationLocked.value = true;
  hiddenIds.value = new Set(cards.map(e => e.card.id));
  await nextTick();
  for (const item of cards) {
    if (token !== dealRun || currentPhase.value !== 'DEALING') break;
    await enqueueFlight(item.card, item.target, item.faceUp);
    hiddenIds.value = new Set([...hiddenIds.value].filter(id => id !== item.card.id));
    tone('drop');
    if (!reducedMotion) await new Promise(resolve => setTimeout(resolve, 38));
  }
  hiddenIds.value = new Set();
  animationLocked.value = false;
}

watch(state, (value, old) => {
  if (!value) return;
  if (value.phase === 'ENDED') recordFinishedMatch();
  // Initial server snapshot is authoritative: replay actual card IDs in round-robin order.
  if (value.phase === 'DEALING' && old?.phase !== 'DEALING' && value.initialDealEndsAt && Date.now() < value.initialDealEndsAt) {
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
  if (value.activeCard?.card.id && value.activeCard.card.id !== old?.activeCard?.card.id) {
    // The deck pointer may have been released before the server confirmed the draw.
    // Never keep the drawn card in a phantom drag state.
    deckGestureHeld.value = false;
    activeDragging.value = false;
    dragTarget.value = null;
    if (value.activeCard.fromDeck && value.activeCard.ownerId === game.playerId) showToast('Карта открыта — перетащи её на игрока или нажми на его стопку');
    activeFlightId.value = value.activeCard.card.id;
    void enqueueFlight(value.activeCard.card, null, true, value.activeCard.fromDeck ? undefined : value.activeCard.ownerId).finally(() => {
      activeFlightId.value = null;
    });
  }
  if (old?.turnIndex !== value.turnIndex && value.phase !== 'LOBBY') tone('turn');
  if (pending.value && old?.activeCard?.card.id !== value.activeCard?.card.id) pending.value = null;
  if (pending.value && value.phase !== old?.phase) pending.value = null;
}, { flush: 'sync' });

watch(() => game.lastReveal, event => {
  if (!event || currentPhase.value !== 'DEALING') return;
  // A special drawn card may land directly on the player's pile without activeCard.
  // Delay until the authoritative state update arrives before deciding its destination.
  setTimeout(() => {
    const snapshot = state.value;
    if (!snapshot || snapshot.phase !== 'DEALING' || snapshot.activeCard?.card.id === event.card.id) return;
    const target = event.targetPlayerId || event.playerId;
    const pile = snapshot.players.find(p => p.id === target)?.stumps || [];
    if (!pile.some(card => card.id === event.card.id)) return;
    hiddenIds.value = new Set([...hiddenIds.value, event.card.id]);
    void flyCard(event.card, target, true).finally(() => {
      const next = new Set(hiddenIds.value);
      next.delete(event.card.id);
      hiddenIds.value = next;
    });
  }, 35);
});

watch(() => game.lastError, message => {
  if (message) { showToast(message); pending.value = null; }
});
watch(() => game.lastVerdict, verdict => {
  if (!verdict) return;
  showToast((verdict.correct ? '☠ Нарушение доказано' : '☠ Ложное обвинение') + ' · ' + verdict.reason);
  tone('penalty');
});
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
  clockTimer = setInterval(() => { clock.value = Date.now(); }, 250);
  name.value = window.Telegram?.WebApp?.initDataUnsafe?.user?.first_name || localStorage.getItem('pidor:name') || '';
  const query = new URLSearchParams(location.search);
  if (query.get('mode') === 'bot') uiTab.value = 'bots';
  const requestRoom = query.get('room');
  if (requestRoom && /^[A-Za-z0-9_-]{1,48}$/.test(requestRoom)) {
    room.value = requestRoom;
    uiTab.value = 'code';
    if (name.value.trim() && localStorage.getItem('pidor:session:' + requestRoom)) {
      joinRoom(requestRoom, { mode: 'friends' });
    }
  }
  void game.fetchTables();
});
onBeforeUnmount(() => {
  ++dealRun;
  clearTimeout(toastTimeout);
  clearInterval(clockTimer);
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
        <button type="button" class="icon-button" aria-label="Профиль и история партий" @click="showProfile = !showProfile">♙</button>
        <div class="stars-placeholder" title="Игровые звёзды появятся позже">★ 0 <small>скоро</small></div>
        <button class="icon-button" type="button" :aria-label="soundOn ? 'Выключить звук' : 'Включить звук'" @click="toggleSound">{{ soundOn ? '♫' : '♪̸' }}</button><button v-if="joined" type="button" class="icon-button" @click="backToLobby" aria-label="К списку столов">⌂</button>
      </div>
    </header>

    <section v-if="showProfile" class="lobby">
      <div class="lobby__panel">
        <h1 class="lobby__title">Мой профиль</h1>
        <p class="lobby__subtitle">{{ name || game.playerName || 'Игрок' }}</p>
        <div class="profile__metrics">
          <span>Партий <b>{{ totalMatches }}</b></span>
          <span>Не последний <b>{{ survivedMatches }}</b></span>
          <span>Штрафов <b>{{ totalPenalties }}</b></span>
        </div>
        <h2 class="profile__heading">Последние партии</h2>
        <div class="profile__history">
          <div v-for="match in history" :key="match.room + match.at" class="profile__match">
            <span>{{ match.result === 'last' ? '☠ Последний' : '✓ Не последний' }} · {{ match.players }} игроков</span>
            <small>{{ new Date(match.at).toLocaleDateString('ru-RU') }} · {{ match.penalties }} штрафов</small>
          </div>
          <p v-if="!history.length" class="lobby__subtitle">Заверши первую партию, чтобы появилась статистика.</p>
        </div>
        <p class="lobby__subtitle">История пока хранится на этом устройстве. Синхронизацию с Telegram добавим отдельно.</p>
        <button class="lobby__button" @click="showProfile = false">Вернуться к игре</button>
      </div>
    </section>
    <section v-else-if="!joined" class="lobby">
      <div class="lobby__panel">
        <h1 class="lobby__title">PIDOR ONLINE</h1>
        <p class="lobby__subtitle">Игра для своих.</p>
        <input class="lobby__field" v-model="name" maxlength="32" autocomplete="nickname" placeholder="Имя игрока" aria-label="Имя игрока" />
        <div class="lobby__tabs">
          <button :class="{ active: uiTab === 'free' }" @click="uiTab='free';game.fetchTables()">Свободные</button>
          <button :class="{ active: uiTab === 'create' }" @click="uiTab='create'">Создать</button>
          <button :class="{ active: uiTab === 'code' }" @click="uiTab='code'">По коду</button>
          <button :class="{ active: uiTab === 'bots' }" @click="uiTab='bots'">Боты</button>
        </div>
        <div v-if="uiTab === 'free'" class="lobby__stack">
          <button v-for="table in game.tables" :key="table.id" class="lobby__room" @click="joinRoom(table.id, { mode: 'friends', underlaidCards: table.underlaidCards })">
            <span>{{ table.title }}</span><small>{{ table.seats }}/{{ table.capacity }} · {{ table.underlaidCards ? 'С подложенными' : 'Без подложенных' }}</small>
          </button>
          <p v-if="!game.tables.length" class="lobby__subtitle">Свободных столов пока нет</p>
          <button class="lobby__secondary" @click="game.fetchTables()">↻ Обновить</button>
        </div>
        <div v-else-if="uiTab === 'create'" class="lobby__stack">
          <input class="lobby__field" v-model="tableTitle" maxlength="36" placeholder="Название стола" />
          <label class="lobby__checkbox"><input type="checkbox" v-model="publicRoom" /> Публичный стол</label>
          <label class="lobby__checkbox"><input type="checkbox" v-model="underlaid" /> Две закрытые карты</label>
          <button class="lobby__button" @click="createRoom">Создать стол</button>
        </div>
        <form v-else-if="uiTab === 'code'" class="lobby__stack" @submit.prevent="join">
          <input class="lobby__field" v-model="room" maxlength="48" placeholder="Код комнаты" required />
          <button class="lobby__button" type="submit">Присоединиться</button>
        </form>
        <div v-else class="lobby__stack">
          <label class="lobby__checkbox"><input type="checkbox" v-model="underlaid" /> Две закрытые карты</label>
          <label class="lobby__subtitle">Ботов: {{ bots }}</label>
          <input type="range" v-model.number="bots" min="1" max="5" />
          <button class="lobby__button" @click="playBots">Играть с ботами</button>
        </div>
        <p class="lobby__subtitle">★ Игра на звёзды — скоро</p>
      </div>
    </section>

    <section v-else-if="state?.phase === 'LOBBY'" class="lobby">
      <div class="lobby__panel">
        <div class="lobby__title">За столом</div>
        <div class="lobby__people">
          <span v-for="p in state.players" :key="p.id" class="lobby__person">◆ {{ p.name }}</span>
        </div>
        <button v-if="state.players.length >= 2 && state.hostId === game.playerId" class="lobby__button" @click="game.startGame()">Начать партию</button>
        <div v-else class="lobby__subtitle">{{ state.players.length < 2 ? "Ожидаем игроков" : "Ожидаем ведущего" }}</div><div class="lobby__subtitle">Код стола: {{ room }}</div><button class="lobby__secondary" @click="inviteFriend">↗ Пригласить друга</button><button class="lobby__secondary" @click="backToLobby">Назад</button>
      </div>
    </section>

    <section v-else-if="state" class="game-viewport">
      <div class="table" :class="{ 'table--six': state.players.length === 6, 'table--five': state.players.length === 5 }">
        <div
          v-for="entry in seats"
          :key="entry.player.id"
          class="table__seat"
          :class="['table__seat--' + entry.slot, { 'table__seat--target': dragTarget === entry.player.id || (state.phase === 'PENALTY_DISTRIBUTION' && state.pendingPenaltyTurn?.receiverId === entry.player.id) }]"
        >
          <PlayerSeat
            :player="entry.player"
            :phase="state.phase"
            :underlaid-cards="state.underlaidCards !== false"
            :is-turn="state.players[state.turnIndex]?.id === entry.player.id"
            :hidden-card-ids="hiddenIds"
            @click="handleSeatClick(entry.player.id)"
            @card-click="handleSeatCard"
          />
        </div>

        <div v-if="me && ['DEALING', 'PENALTY_REVIEW'].includes(state.phase)" class="table__seat table__seat--self">
          <PlayerSeat
            :player="me"
            :phase="state.phase"
            :underlaid-cards="state.underlaidCards !== false"
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

        <div data-drop-zone="trick" class="table__play-target" :class="{ 'table__play-target--enabled': canPlay, 'table__play-target--dragover': fanHover }"></div>
        <div class="table__trick" :style="state.phase === 'MAIN_GAME' ? trickPosition : {}">
          <div v-for="(card,i) in state.currentTrick" :key="card.id" :style="{ '--trick-rot': (i * 6 - 4) + 'deg', '--trick-x': (i * 8) + 'px', '--trick-y': (i * -4) + 'px' }">
            <CardComponent :card="card" small />
          </div>
        </div>
        <div class="table__active-anchor"></div>
        <div v-if="active && activeFlightId !== active.card.id"
          class="table__active" :class="{ 'table__active--drag': activeDragging, 'table__active--dealing': state.phase === 'DEALING' }"
          :style="activeDragging ? { '--drag-x': dragPoint.x + 'px', '--drag-y': dragPoint.y + 'px' } : {}"
          @pointerdown="onActiveDown"
        >
          <CardComponent :card="active.card" />
        </div>
        <div v-if="active && !activeDragging && isMyTurn && state.phase === 'DEALING'" class="table__target-hint">
          Перенеси карту на игрока
        </div>
      </div>

      <footer class="hand-area" :class="{ 'hand-area--fan': ['MAIN_GAME', 'PENALTY_DISTRIBUTION'].includes(state.phase) }">
        <div class="hand-area__actions">
          <button v-if="['DEALING', 'PENALTY_REVIEW', 'MAIN_GAME'].includes(state.phase)" class="action-pill action-pill--quiet" @click="accuseSelected" :disabled="!selectedAccused">☠ ПОХУЁВАЯ! {{ selectedAccused ? state.players.find(p => p.id === selectedAccused)?.name : '' }}</button>
          <button v-if="state.phase === 'PENALTY_REVIEW'" class="action-pill action-pill--quiet" @click="game.finishReview()">Продолжить <span v-if="reviewSeconds">· {{ reviewSeconds }}с</span></button>
          <button v-if="state.phase === 'MAIN_GAME' && isMyTurn && state.currentTrick.length" class="action-pill" @click="game.takeTrick()">Забрать</button>
          <button v-if="me && !me.hand.length && me.stumps.length && state.phase === 'MAIN_GAME'" class="action-pill" @click="game.takeStumps()">Беру пеньки</button>
          <button v-if="me && !me.hand.length && !me.stumps.length && state.phase === 'MAIN_GAME'" class="action-pill action-pill--quiet" @click="game.exitGame()">Выйти</button>
        </div>
        <div v-if="me" class="hand-area__label">{{ handLabel }}</div>
        <HandFan v-if="me && ['MAIN_GAME', 'PENALTY_DISTRIBUTION'].includes(state.phase)" :cards="me.hand"
          :disabled="state.phase === 'MAIN_GAME' ? !canPlay : (state.pendingPenaltyTurn?.giverId !== game.playerId || animationLocked || !!pending)"
          :allow-seat-drop="state.phase === 'PENALTY_DISTRIBUTION'"
          :selected-card-id="selectedPenalty?.id"
          @give="givePenalty"
          @choose="selectedPenalty = $event"
          @play="playCard"
          @select="tone('select')" @hover="fanHover = $event"
        />
      </footer>
      <Transition name="toast">
        <section v-if="state.phase === 'ENDED'" class="end-screen" aria-live="polite">
          <span class="end-screen__eyebrow">Партия завершена</span>
          <h2>Игра окончена</h2>
          <p v-if="loser">☠ {{ loser.name }} · последний за столом</p>
          <div class="end-screen__scores">
            <span v-for="p in state.players" :key="p.id">{{ p.name }} <b>☠ {{ p.penalties }}</b></span>
          </div>
          <button class="lobby__button" @click="backToLobby">К новым партиям</button>
        </section>
      </Transition>
    </section>
    <section v-else class="lobby">
      <div class="lobby__panel" role="status">
        <p class="lobby__subtitle">{{ game.connected ? 'Подключаемся к столу…' : 'Соединяемся с сервером…' }}</p>
        <p v-if="game.lastError" class="lobby__subtitle">{{ game.lastError }}</p>
        <button class="lobby__secondary" @click="backToLobby">К списку столов</button>
      </div>
    </section>

    <Transition name="toast">
      <div v-if="alertText" class="toast" role="status">{{ alertText }}</div>
    </Transition>
    <div v-if="vfx" :key="vfx.id" class="table-vfx" :class="'table-vfx--' + vfx.kind" :style="{ left: vfx.x + 'px', top: vfx.y + 'px' }"><i v-for="n in 8" :key="n" :style="{ '--spark-angle': (n * 45) + 'deg' }"></i></div>
    <div v-if="flight" ref="flightRef" class="card-flight" :style="{ transform: `translate(${flightOrigin.x}px, ${flightOrigin.y}px)` }">
      <div class="card-flight__body"><CardComponent :card="flight.card" :hidden="flight.hidden" /></div>
    </div>
  </main>
</template>

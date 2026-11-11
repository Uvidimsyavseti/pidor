<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useGameStore } from './stores/game';
import PlayerSeat from './components/PlayerSeat.vue';
import CardComponent from './components/CardComponent.vue';
import type { Card } from '@shared/types';

const gameStore = useGameStore();
const name = ref('');
const room = ref(new URLSearchParams(window.location.search).get('room') || 'pidor-1');
const joined = ref(false);
watch(() => gameStore.error, error => { if (error) joined.value = false; });

const selectedCard = ref<Card | null>(null);

onMounted(() => {
  gameStore.connect();
  const tg = (window as Window & { Telegram?: { WebApp?: { ready?: () => void; expand?: () => void; initDataUnsafe?: { user?: { first_name?: string; username?: string }; start_param?: string } } } }).Telegram?.WebApp;
  tg?.ready?.();
  tg?.expand?.();
  if (tg?.initDataUnsafe?.user) name.value = tg.initDataUnsafe.user.first_name || tg.initDataUnsafe.user.username || '';
  if (tg?.initDataUnsafe?.start_param?.startsWith('room_')) room.value = tg.initDataUnsafe.start_param.slice(5);
});

function join() {
  if (name.value) {
    gameStore.joinRoom(name.value, room.value);
    joined.value = true;
  }
}

const me = computed(() => gameStore.gameState?.players.find(p => p.id === gameStore.playerId));
const others = computed(() => {
  if (!gameStore.gameState || !me.value) return [];
  const players = [...gameStore.gameState.players];
  const myIndex = players.findIndex(p => p.id === me.value?.id);
  if (myIndex !== -1) {
    return [...players.slice(myIndex + 1), ...players.slice(0, myIndex)];
  }
  return players;
});

const isMyTurn = computed(() => {
  return gameStore.gameState?.players[gameStore.gameState.turnIndex]?.id === gameStore.playerId;
});

const phaseInfo = computed(() => {
  if (!gameStore.gameState) return '';
  switch (gameStore.gameState.phase) {
    case 'LOBBY': return 'Ожидание';
    case 'DEALING': return 'Раздача';
    case 'PENALTY_DISTRIBUTION': return 'Хуевые';
    case 'MAIN_GAME': return 'Игра';
    default: return '';
  }
});

function handleCardClick({ card, ownerId }: { card: Card, ownerId: string }) {
  if (!gameStore.gameState) return;
  
  // Dealing phase: click card to take it or place active card
  if (gameStore.gameState.phase === 'DEALING') {
    if (gameStore.gameState.activeCard) {
      gameStore.placeActiveCard(ownerId);
    } else if (ownerId === gameStore.playerId && isMyTurn.value) {
      gameStore.takeFromPile(card.id);
    }
    return;
  }

  // Main game / Penalty distribution
  if (gameStore.gameState.phase === 'MAIN_GAME') {
    if (isMyTurn.value) gameStore.playCard(card.id);
  } else if (gameStore.gameState.phase === 'PENALTY_DISTRIBUTION') {
    if (ownerId === gameStore.playerId) selectedCard.value = card;
    else if (selectedCard.value) {
      gameStore.givePenaltyCard(selectedCard.value.id, ownerId);
      selectedCard.value = null;
    }
  }
}

function handleSeatClick(playerId: string) {
  if (gameStore.gameState?.phase === 'DEALING' && gameStore.gameState.activeCard) {
    gameStore.placeActiveCard(playerId);
  } else if (gameStore.gameState?.phase === 'PENALTY_DISTRIBUTION' && selectedCard.value) {
    gameStore.givePenaltyCard(selectedCard.value.id, playerId);
    selectedCard.value = null;
  }
}

function drawCard() {
  if (gameStore.gameState?.phase === 'DEALING' && isMyTurn.value && !gameStore.gameState.activeCard) {
    gameStore.drawCardFromDeck();
  }
}

function invite() {
  const url = new URL(window.location.href);
  url.searchParams.set('room', room.value);
  const link = url.toString();
  const tg = (window as Window & { Telegram?: { WebApp?: { openTelegramLink?: (url: string) => void } } }).Telegram?.WebApp;
  if (tg && import.meta.env.VITE_TELEGRAM_BOT_USERNAME) {
    const bot = import.meta.env.VITE_TELEGRAM_BOT_USERNAME.replace(/^@/, '');
    tg.openTelegramLink?.('https://t.me/' + bot + '?startapp=room_' + encodeURIComponent(room.value));
  } else { navigator.clipboard?.writeText(link).catch(() => window.prompt('Ссылка для приглашения', link)); }
}

const penaltyPlayerName = computed(() => {
  if (!gameStore.lastPenalty) return '';
  return gameStore.gameState?.players.find(p => p.id === gameStore.lastPenalty?.playerId)?.name || 'Кто-то';
});
</script>

<template>
  <div class="p-2 h-screen flex flex-col bg-slate-950 text-slate-100 font-sans select-none overflow-hidden">
    <!-- Auth -->
    <div v-if="!joined" class="flex-1 flex flex-col items-center justify-center gap-6">
      <h1 class="text-6xl font-black text-yellow-500 italic tracking-tighter">PIDOR</h1>
      <div class="bg-slate-900 p-8 rounded-3xl border border-slate-800 flex flex-col gap-4 w-80 shadow-2xl">
        <input v-model="name" placeholder="Имя" class="p-4 rounded-xl bg-slate-800 border border-slate-700 text-white outline-none focus:ring-2 ring-yellow-500" />
        <input v-model="room" placeholder="Комната" class="p-4 rounded-xl bg-slate-800 border border-slate-700 text-white outline-none focus:ring-2 ring-yellow-500" />
        <div v-if="gameStore.error" class="text-red-400 text-xs">{{ gameStore.error }}</div>
        <button @click="join" class="bg-yellow-500 text-slate-950 py-4 rounded-xl font-black text-xl active:scale-95 transition-all shadow-lg">ИГРАТЬ</button>
      </div>
    </div>

    <!-- Game -->
    <div v-else-if="gameStore.gameState" class="flex-1 flex flex-col relative">
      <div v-if="gameStore.error" class="bg-red-700 rounded-lg px-4 py-2">{{ gameStore.error }}</div>
      <!-- Penalty Notification -->
      <Transition name="slide">
        <div v-if="gameStore.lastPenalty" class="absolute top-20 left-1/2 -translate-x-1/2 z-50 bg-red-600 px-6 py-3 rounded-2xl shadow-[0_0_40px_rgba(220,38,38,0.5)] border-2 border-red-400 text-center min-w-[300px]">
          <div class="font-black text-xl uppercase tracking-tighter">ПО ХУЕВОЙ!</div>
          <div class="text-xs font-bold text-red-100">{{ penaltyPlayerName }}: {{ gameStore.lastPenalty.reason }}</div>
        </div>
      </Transition>

      <header class="flex justify-between items-center px-4 py-2 z-20">
        <div class="flex flex-col">
          <span class="text-[10px] font-black text-slate-500 uppercase">{{ room }}</span>
          <span class="text-sm font-bold text-yellow-500 uppercase">{{ phaseInfo }}</span>
        </div>
        <div class="flex gap-2">
           <button @click="invite" class="bg-slate-700 px-4 py-1.5 rounded-full text-[10px] font-black uppercase">Пригласить</button>
           <button @click="gameStore.takeStumps()" v-if="me?.hand.length === 0 && me?.stumps.length > 0" class="bg-blue-600 px-4 py-1.5 rounded-full text-[10px] font-black uppercase">Пеньки</button>
           <button @click="gameStore.exitGame()" v-if="me?.hand.length === 0 && me?.stumps.length === 0" class="bg-red-600 px-4 py-1.5 rounded-full text-[10px] font-black uppercase">Выход</button>
        </div>
      </header>

      <div v-if="gameStore.gameState.phase === 'LOBBY'" class="flex-1 flex flex-col items-center justify-center gap-8">
        <div class="flex flex-wrap justify-center gap-4 max-w-md">
           <div v-for="p in gameStore.gameState.players" :key="p.id" class="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center gap-4 min-w-[140px]">
              <div class="w-10 h-10 bg-yellow-500/10 rounded-full flex items-center justify-center font-black text-yellow-500">{{ p.name[0] }}</div>
              <span class="font-bold text-sm">{{ p.name }}</span>
           </div>
        </div>
        <button v-if="gameStore.gameState.players.length >= 2" @click="gameStore.startGame" class="bg-yellow-500 text-slate-950 px-12 py-4 rounded-2xl text-2xl font-black active:scale-95 transition-all">ПОЕХАЛИ</button>
      </div>

      <div v-else class="flex-1 flex flex-col py-4 relative">
        <!-- Others -->
        <div class="flex justify-center gap-4 h-1/4">
          <PlayerSeat 
            v-for="p in others" 
            :key="p.id" 
            :player="p" 
            :isMe="false" 
            :phase="gameStore.gameState.phase"
            :isTurn="gameStore.gameState.players[gameStore.gameState.turnIndex]?.id === p.id"
            @cardClick="handleCardClick"
            @click="handleSeatClick(p.id)"
          />
        </div>

        <!-- Center -->
        <div class="flex-1 flex items-center justify-center gap-16 relative">
          <!-- Active Card -->
          <div v-if="gameStore.gameState.activeCard" class="absolute z-30 scale-150 animate-in fade-in zoom-in duration-300 pointer-events-none">
             <CardComponent :card="gameStore.gameState.activeCard.card" />
          </div>

          <!-- Deck -->
          <div class="relative" v-if="gameStore.gameState.deck.length > 0">
            <CardComponent 
              hidden 
              :class="{ 
                'cursor-pointer hover:-translate-y-2 ring-4 ring-yellow-500 shadow-[0_0_20px_rgba(234,179,8,0.4)]': isMyTurn && gameStore.gameState.phase === 'DEALING' && !gameStore.gameState.activeCard,
                'opacity-20 grayscale': gameStore.gameState.activeCard || !isMyTurn
              }" 
              @click="drawCard" 
            />
            <div class="absolute -bottom-6 inset-x-0 text-center text-[10px] font-black text-slate-600">{{ gameStore.gameState.deck.length }} КАРТ</div>
          </div>

          <!-- Trick -->
          <div class="flex flex-col items-center gap-6">
            <div class="flex -space-x-12 min-w-[120px] justify-center">
              <CardComponent v-for="(card, i) in gameStore.gameState.currentTrick" :key="card.id" :card="card" :style="{ transform: `rotate(${i * 8 - 4}deg)` }" />
              <div v-if="gameStore.gameState.currentTrick.length === 0" class="w-16 h-24 border-2 border-dashed border-slate-800 rounded-xl flex items-center justify-center text-[10px] font-black text-slate-800 uppercase">СТОЛ</div>
            </div>
            <button v-if="isMyTurn && gameStore.gameState.currentTrick.length > 0 && gameStore.gameState.phase === 'MAIN_GAME'" @click="gameStore.takeTrick()" class="bg-white text-slate-950 px-6 py-2 rounded-xl font-black text-xs uppercase shadow-xl animate-bounce">Забрать</button>
          </div>

          <!-- Trash -->
          <div class="relative w-16 h-24 opacity-40" v-if="gameStore.gameState.discardPile.length > 0">
             <CardComponent hidden class="rotate-12" />
             <div class="absolute -bottom-6 inset-x-0 text-center text-[10px] font-black text-slate-700">ОТБОЙ ({{ gameStore.gameState.discardPile.length }})</div>
          </div>
        </div>

        <!-- My Area -->
        <div class="h-1/3 flex flex-col items-center justify-end gap-4 relative">
          <div v-if="me" class="w-full flex justify-center">
            <PlayerSeat 
              :player="me" :isMe="true" :phase="gameStore.gameState.phase" :isTurn="isMyTurn" 
              :selectedCardId="selectedCard?.id"
              @cardClick="handleCardClick"
              @click="handleSeatClick(me.id)"
            />
          </div>
        </div>

        <!-- Trump -->
        <div class="absolute bottom-8 left-8 flex flex-col items-center bg-slate-900/50 p-3 rounded-2xl border border-slate-800">
          <span class="text-[10px] font-black text-slate-500 uppercase mb-1">Козырь</span>
          <div class="text-4xl" :class="{ 'text-red-500': gameStore.gameState.trumpSuit === 'hearts' || gameStore.gameState.trumpSuit === 'diamonds' }">
            {{ {hearts:'♥', diamonds:'♦', clubs:'♣', spades:'♠'}[gameStore.gameState.trumpSuit || ''] || '?' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.slide-enter-active, .slide-leave-active { transition: all 0.3s ease-out; }
.slide-enter-from { transform: translate(-50%, -100%); opacity: 0; }
.slide-leave-to { transform: translate(-50%, -100%); opacity: 0; }
</style>

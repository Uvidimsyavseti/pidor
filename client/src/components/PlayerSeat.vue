<script setup lang="ts">
import type { Player, Card } from '@shared/types';
import CardComponent from './CardComponent.vue';

const props = defineProps<{
  player: Player;
  isMe: boolean;
  isTurn: boolean;
  phase: string;
  selectedCardId?: string | null;
}>();

const emit = defineEmits(['cardClick', 'click']);

function handleCardClick(event: Event, card: Card | undefined) {
  event.stopPropagation();
  if (!card) return;
  emit('cardClick', { card, ownerId: props.player.id });
}
</script>

<template>
  <div class="flex flex-col items-center gap-2 p-3 rounded-2xl transition-all relative cursor-pointer"
    @click="$emit('click')"
    :class="[isTurn ? 'bg-yellow-500/10 ring-2 ring-yellow-500 shadow-[0_0_30px_rgba(234,179,8,0.2)]' : '']"
  >
    <div v-if="isTurn" class="absolute -top-1 -right-1 w-3 h-3 bg-yellow-500 rounded-full animate-ping"></div>

    <div class="flex flex-col items-center leading-tight pointer-events-none">
      <span class="font-black text-xs uppercase tracking-wider flex items-center gap-1">
        {{ player.name }}
        <span v-if="player.penalties > 0" class="bg-red-600 text-[10px] px-1.5 py-0.5 rounded-md text-white">
          {{ player.penalties }}
        </span>
      </span>
      <span v-if="player.onDuty" class="text-[9px] text-yellow-500 font-black">НА ВАХТЕ</span>
      <span v-if="player.hasExited" class="text-[9px] text-green-500 font-black">ВЫШЕЛ</span>
    </div>

    <!-- Piles -->
    <div class="relative w-12 h-16 flex items-center justify-center">
      <template v-if="phase === 'DEALING'">
        <div v-for="n in Math.min(player.stumps.length, 5)" :key="n" 
          class="absolute w-10 h-14 border border-slate-700 rounded-lg bg-slate-800 shadow-sm pointer-events-none"
          :style="{ transform: `translate(${(n-1)*1}px, ${(n-1)*-1}px)` }"
        ></div>
        <div v-if="player.stumps.length > 0" class="relative z-10" :style="{ transform: `translate(${(Math.min(player.stumps.length, 5)-1)*1}px, ${(Math.min(player.stumps.length, 5)-1)*-1}px)` }">
          <CardComponent 
            v-if="player.stumps.length > 2"
            :card="player.stumps[player.stumps.length - 1]" 
            small 
            @click="handleCardClick($event, player.stumps[player.stumps.length - 1])"
            :class="{ 'ring-4 ring-yellow-400': isMe && selectedCardId === player.stumps[player.stumps.length-1]?.id }"
          />
          <CardComponent v-else hidden small class="pointer-events-none" />
        </div>
      </template>
      <template v-else>
         <div class="flex gap-1 pointer-events-none">
            <CardComponent v-for="n in player.stumps.length" :key="'s'+n" hidden small />
         </div>
      </template>
    </div>

    <!-- Hand Cards -->
    <div class="mt-2 flex -space-x-6 hover:space-x-1 transition-all">
      <template v-if="isMe">
        <CardComponent 
          v-for="card in player.hand" 
          :key="card.id" 
          :card="card" 
          small 
          class="hover:-translate-y-4 transition-transform"
          :class="{ 'ring-4 ring-yellow-400 scale-110 z-20': selectedCardId === card.id }"
          @click="handleCardClick($event, card)"
        />
      </template>
      <template v-else>
        <div v-for="n in Math.min(player.hand.length, 8)" :key="n" 
          class="w-6 h-10 bg-gradient-to-br from-blue-800 to-blue-950 border border-blue-500/30 rounded-sm shadow-sm"
        ></div>
      </template>
    </div>
  </div>
</template>

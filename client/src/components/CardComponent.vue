<script setup lang="ts">
import type { Card, Suit, Rank } from '@shared/types';

const props = defineProps<{
  card?: Card;
  hidden?: boolean;
  small?: boolean;
}>();

const suitSymbols: Record<Suit, string> = {
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
  spades: '♠'
};

const rankLabels: Record<Rank, string> = {
  '6': '6', '7': '7', '8': '8', '9': '9', '10': '10', 'J': 'В', 'Q': 'Д', 'K': 'К', 'A': 'Т'
};

const suitColor = (suit: Suit) => (suit === 'hearts' || suit === 'diamonds' ? 'text-red-600' : 'text-slate-900');
</script>

<template>
  <div 
    class="relative rounded-xl border shadow-lg flex items-center justify-center font-bold bg-white select-none transition-all"
    :class="[
      small ? 'w-10 h-14 text-sm' : 'w-20 h-28 text-2xl',
      hidden ? 'bg-gradient-to-br from-blue-700 to-blue-900 border-blue-400' : 'border-slate-200'
    ]"
  >
    <template v-if="!hidden && card">
      <!-- Top Left Rank Only -->
      <div class="absolute top-1.5 left-2 leading-none text-[0.7rem] font-black uppercase" :class="suitColor(card.suit)">
        {{ rankLabels[card.rank] }}
      </div>
      
      <!-- Central Suit Icon (Exactly one) -->
      <div :class="[suitColor(card.suit), small ? 'text-2xl' : 'text-5xl']" class="filter drop-shadow-sm">
        {{ suitSymbols[card.suit] }}
      </div>
    </template>
    
    <!-- Card Back -->
    <div v-else-if="hidden" class="w-full h-full flex items-center justify-center">
       <div class="w-4/5 h-4/5 border border-blue-400/30 rounded-lg flex items-center justify-center">
          <div class="text-blue-400/20 text-2xl font-black italic select-none">P</div>
       </div>
    </div>
  </div>
</template>

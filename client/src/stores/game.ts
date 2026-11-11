import { defineStore } from 'pinia';
import { io, Socket } from 'socket.io-client';
import type { GameState } from '@shared/types';

export const useGameStore = defineStore('game', {
  state: () => ({
    socket: null as Socket | null,
    gameState: null as GameState | null,
    playerName: '',
    roomId: 'default',
    lastPenalty: null as { playerId: string, reason: string } | null,
  }),
  actions: {
    connect() {
      this.socket = io('http://localhost:3001');
      this.socket.on('gameStateUpdate', (state: GameState) => {
        this.gameState = state;
      });
      this.socket.on('penalty', (data: { playerId: string, reason: string }) => {
        this.lastPenalty = data;
        setTimeout(() => {
          if (this.lastPenalty === data) this.lastPenalty = null;
        }, 4000);
      });
    },
    joinRoom(name: string, room: string) {
      this.playerName = name;
      this.roomId = room;
      this.socket?.emit('joinRoom', { roomId: room, playerName: name });
    },
    startGame() {
      this.socket?.emit('startGame', this.roomId);
    },
    drawCardFromDeck() {
      this.socket?.emit('drawCardFromDeck', { roomId: this.roomId });
    },
    takeFromPile(cardId: string) {
      this.socket?.emit('takeFromPile', { roomId: this.roomId, cardId });
    },
    placeActiveCard(targetPlayerId: string) {
      this.socket?.emit('placeActiveCard', { roomId: this.roomId, targetPlayerId });
    },
    givePenaltyCard(cardId: string, receiverId: string) {
      this.socket?.emit('givePenaltyCard', { roomId: this.roomId, cardId, receiverId });
    },
    playCard(cardId: string) {
      this.socket?.emit('playCard', { roomId: this.roomId, cardId });
    },
    takeTrick() {
      this.socket?.emit('takeTrick', { roomId: this.roomId });
    },
    takeStumps() {
      this.socket?.emit('takeStumps', { roomId: this.roomId });
    },
    exitGame() {
      this.socket?.emit('exitGame', { roomId: this.roomId });
    }
  },
});

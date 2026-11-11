import { defineStore } from 'pinia';
import { io, type Socket } from 'socket.io-client';
import type { GameState } from '@shared/types';

const socketUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const sessionKey = (room: string) => 'pidor-session:' + room;
function telegramInitData(): string {
  return (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData || '';
}
export const useGameStore = defineStore('game', {
  state: () => ({
    socket: null as Socket | null,
    gameState: null as GameState | null,
    playerId: '',
    playerName: '',
    roomId: 'default',
    joined: false,
    error: '',
    lastPenalty: null as { playerId: string, reason: string } | null
  }),
  actions: {
    connect() {
      if (this.socket) return;
      this.socket = io(socketUrl, { autoConnect: true });
      this.socket.on('connect', () => { if (this.joined) this.sendJoin(); });
      this.socket.on('joined', ({ playerId, sessionToken, name }: { playerId: string; sessionToken: string; name: string }) => {
        this.playerId = playerId;
        this.playerName = name;
        this.error = '';
        sessionStorage.setItem(sessionKey(this.roomId), sessionToken);
      });
      this.socket.on('joinError', (message: string) => { this.error = message; this.joined = false; });
      this.socket.on('gameStateUpdate', (state: GameState) => { this.gameState = state; });
      this.socket.on('penalty', (data: { playerId: string; reason: string }) => {
        this.lastPenalty = data;
        setTimeout(() => { if (this.lastPenalty === data) this.lastPenalty = null; }, 4000);
      });
    },
    sendJoin() {
      this.socket?.emit('joinRoom', {
        roomId: this.roomId, playerName: this.playerName,
        sessionToken: sessionStorage.getItem(sessionKey(this.roomId)) || '',
        initData: telegramInitData()
      });
    },
    joinRoom(name: string, room: string) {
      this.playerName = name;
      this.roomId = room;
      this.joined = true;
      this.error = '';
      if (this.socket?.connected) this.sendJoin();
    },
    startGame() { this.socket?.emit('startGame', this.roomId); },
    drawCardFromDeck() { this.socket?.emit('drawCardFromDeck', { roomId: this.roomId }); },
    takeFromPile(cardId: string) { this.socket?.emit('takeFromPile', { roomId: this.roomId, cardId }); },
    placeActiveCard(targetPlayerId: string) { this.socket?.emit('placeActiveCard', { roomId: this.roomId, targetPlayerId }); },
    givePenaltyCard(cardId: string, receiverId: string) { this.socket?.emit('givePenaltyCard', { roomId: this.roomId, cardId, receiverId }); },
    playCard(cardId: string) { this.socket?.emit('playCard', { roomId: this.roomId, cardId }); },
    takeTrick() { this.socket?.emit('takeTrick', { roomId: this.roomId }); },
    takeStumps() { this.socket?.emit('takeStumps', { roomId: this.roomId }); },
    exitGame() { this.socket?.emit('exitGame', { roomId: this.roomId }); }
  }
});

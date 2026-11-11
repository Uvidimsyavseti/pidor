import { defineStore } from 'pinia';
import type { GameState } from '@shared/types';
const sessionKey = (room: string) => 'pidor-session:' + room;
const server = (room: string) => {
  const root = new URL(import.meta.env.VITE_SERVER_URL || location.origin);
  root.protocol = root.protocol === 'https:' ? 'wss:' : 'ws:';
  root.pathname = '/ws';
  root.searchParams.set('room', room);
  return root.toString();
};
function telegramInitData(): string {
  return (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData || '';
}
export const useGameStore = defineStore('game', {
  state: () => ({
    socket: null as WebSocket | null,
    gameState: null as GameState | null,
    playerId: '', playerName: '', roomId: 'pidor-1',
    joined: false, connected: false, connecting: false, reconnect: false, error: '',
    lastPenalty: null as { playerId: string; reason: string } | null
  }),
  actions: {
    connect() { /* open on join */ },
    openSocket() {
      if (!this.reconnect || this.socket) return;
      this.connecting = true;
      this.error = '';
      const ws = new WebSocket(server(this.roomId));
      this.socket = ws;
      ws.onopen = () => {
        this.connected = true;
        this.connecting = false;
        ws.send(JSON.stringify({ type: 'joinRoom', data: {
          playerName: this.playerName,
          sessionToken: sessionStorage.getItem(sessionKey(this.roomId)) || '',
          initData: telegramInitData()
        }}));
      };
      ws.onmessage = event => {
        let message: { type: string; data: unknown };
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'joined') {
          const info = message.data as { playerId: string; sessionToken: string; name: string };
          this.playerId = info.playerId;
          this.playerName = info.name;
          this.joined = true;
          this.connecting = false;
          this.error = '';
          sessionStorage.setItem(sessionKey(this.roomId), info.sessionToken);
        } else if (message.type === 'joinError') {
          this.error = String(message.data);
          this.joined = false;
          this.connecting = false;
          this.reconnect = false;
          ws.close();
        } else if (message.type === 'gameStateUpdate') this.gameState = message.data as GameState;
        else if (message.type === 'penalty') {
          const data = message.data as { playerId: string; reason: string };
          this.lastPenalty = data;
          setTimeout(() => { if (this.lastPenalty === data) this.lastPenalty = null; }, 4000);
        }
      };
      ws.onerror = () => { this.error = 'Сервер недоступен — проверь подключение'; };
      ws.onclose = () => {
        if (this.socket !== ws) return;
        this.connected = false;
        this.connecting = false;
        this.socket = null;
        if (this.reconnect) {
          this.error = 'Переподключение к серверу…';
          setTimeout(() => { if (this.reconnect && !this.socket) this.openSocket(); }, 2500);
        }
      };
    },
    joinRoom(name: string, room: string) {
      if (!/^[a-zA-Z0-9_-]{1,48}$/.test(room)) { this.error = 'Комната: 1–48 латинских букв, цифр, - или _'; return; }
      if (!name.trim() || name.length > 32) { this.error = 'Введи имя от 1 до 32 символов'; return; }
      this.reconnect = false;
      this.socket?.close();
      this.socket = null;
      this.gameState = null;
      this.joined = false;
      this.playerId = '';
      this.roomId = room;
      this.playerName = name.trim();
      this.reconnect = true;
      this.openSocket();
    },
    send(type: string, data: Record<string, unknown> = {}) {
      if (this.socket?.readyState === WebSocket.OPEN && this.joined) {
        this.socket.send(JSON.stringify({ type, data }));
      }
    },
    startGame() { this.send('startGame'); },
    drawCardFromDeck() { this.send('drawCardFromDeck'); },
    takeFromPile(cardId: string) { this.send('takeFromPile', { cardId }); },
    placeActiveCard(targetPlayerId: string) { this.send('placeActiveCard', { targetPlayerId }); },
    givePenaltyCard(cardId: string, receiverId: string) { this.send('givePenaltyCard', { cardId, receiverId }); },
    playCard(cardId: string) { this.send('playCard', { cardId }); },
    takeTrick() { this.send('takeTrick'); },
    takeStumps() { this.send('takeStumps'); },
    exitGame() { this.send('exitGame'); }
  }
});
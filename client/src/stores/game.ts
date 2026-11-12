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
    playerId: '', playerName: '', roomId: 'pidor-1', tableTitle: '',
    roomMode: 'friends' as 'friends' | 'bot', botCount: 1,
    heartbeat: null as ReturnType<typeof setInterval> | null,
    joined: false, connected: false, connecting: false, reconnect: false, error: '',
    lastPenalty: null as { playerId: string; reason: string } | null,
    penaltySplash: false, splashSequence: 0,
    verdictToast: null as { correct: boolean; accuserId: string; accusedId: string; penalizedId: string; reason: string } | null
  }),
  actions: {
    connect() { /* open on join */ },
    async loadTableTitle(roomId: string) {
      try {
        const response = await fetch('/api/room?id=' + encodeURIComponent(roomId), { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json() as { table?: { title?: string } };
        if (this.roomId === roomId && data.table?.title) this.tableTitle = data.table.title;
      } catch { /* old rooms without directory metadata work normally */ }
    },
    openSocket() {
      if (!this.reconnect || this.socket) return;
      this.connecting = true;
      this.error = '';
      const ws = new WebSocket(server(this.roomId));
      this.socket = ws;
      ws.onopen = () => {
        this.connected = true;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN && this.joined) ws.send(JSON.stringify({ type: 'ping' }));
        }, 20_000);
        this.connecting = false;
        ws.send(JSON.stringify({ type: 'joinRoom', data: {
          playerName: this.playerName,
          mode: this.roomMode, botCount: this.botCount,
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
          setTimeout(() => { if (this.lastPenalty === data) this.lastPenalty = null; }, 2500);
        } else if (message.type === 'penaltyAwarded') {
          this.splashSequence++;
          const sequence = this.splashSequence;
          this.penaltySplash = true;
          this.lastPenalty = null;
          setTimeout(() => {
            if (this.splashSequence === sequence) this.penaltySplash = false;
          }, 1900);
        } else if (message.type === 'accusationVerdict') {
          const data = message.data as { correct: boolean; accuserId: string; accusedId: string; penalizedId: string; reason: string };
          this.verdictToast = data;
          setTimeout(() => { if (this.verdictToast === data) this.verdictToast = null; }, 3000);
        } else if (message.type === 'actionError') {
          this.error = String(message.data);
          setTimeout(() => { if (this.error === message.data) this.error = ''; }, 3200);
        } else if (message.type === 'penaltyCardReceived') {
          // Physical card transfers are distinct from awarding a foul.
          // Do not show the full-screen foul animation for an ordinary transfer.
        }
      };
      ws.onerror = () => { this.error = 'Сервер недоступен — проверь подключение'; };
      ws.onclose = () => {
        if (this.socket !== ws) return;
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
        this.connected = false;
        this.connecting = false;
        this.socket = null;
        if (this.reconnect) {
          this.error = 'Переподключение к серверу…';
          setTimeout(() => { if (this.reconnect && !this.socket) this.openSocket(); }, 2500);
        }
      };
    },
    joinRoom(name: string, room: string, mode: 'friends' | 'bot' = 'friends', botCount = 1) {
      if (!/^[a-zA-Z0-9_-]{1,48}$/.test(room)) { this.error = 'Комната: 1–48 латинских букв, цифр, - или _'; return; }
      if (!name.trim() || name.length > 32) { this.error = 'Введи имя от 1 до 32 символов'; return; }
      this.reconnect = false;
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      this.socket?.close();
      this.socket = null;
      this.gameState = null;
      this.lastPenalty = null;
      this.penaltySplash = false;
      this.verdictToast = null;
      this.joined = false;
      this.playerId = '';
      this.roomId = room;
      this.tableTitle = '';
      this.roomMode = mode;
      this.botCount = Math.max(1, Math.min(3, Math.floor(botCount)));
      this.playerName = name.trim();
      this.reconnect = true;
      if (mode === 'friends') void this.loadTableTitle(room);
      this.openSocket();
    },
    leaveRoom() {
      this.reconnect = false;
      this.joined = false;
      this.connected = false;
      this.connecting = false;
      this.error = '';
      this.gameState = null;
      this.playerId = '';
      this.tableTitle = '';
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      this.socket?.close(1000, 'Leaving table');
      this.socket = null;
    },
    send(type: string, data: Record<string, unknown> = {}) {
      if (this.socket?.readyState === WebSocket.OPEN && this.joined) {
        this.socket.send(JSON.stringify({ type, data }));
      }
    },
    startGame() { this.send('startGame'); },
    accusePlayer(accusedId: string) { this.send('accusePlayer', { accusedId }); },
    finishReview() { this.send('finishReview'); },
    drawCardFromDeck() { this.send('drawCardFromDeck'); },
    drawTo(targetPlayerId: string) { this.send('drawTo', { targetPlayerId }); },
    moveTopTo(targetPlayerId: string) { this.send('moveTopTo', { targetPlayerId }); },
    takeFromPile(cardId: string) { this.send('takeFromPile', { cardId }); },
    placeActiveCard(targetPlayerId: string) { this.send('placeActiveCard', { targetPlayerId }); },
    givePenaltyCard(cardId: string, receiverId: string) { this.send('givePenaltyCard', { cardId, receiverId }); },
    playCard(cardId: string) { this.send('playCard', { cardId }); },
    takeTrick() { this.send('takeTrick'); },
    takeStumps() { this.send('takeStumps'); },
    exitGame() { this.send('exitGame'); }
  }
});
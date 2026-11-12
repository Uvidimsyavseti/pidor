import { defineStore } from 'pinia';
import type { Card, CardDrawReveal, GameState, TableListing } from '@shared/types';

type GameMessage = { type: string; data: unknown };
type JoinOptions = { mode?: 'friends' | 'bot'; botCount?: number; underlaidCards?: boolean };
type Verdict = { correct: boolean; accusedId: string; penalizedId: string; reason: string; accuserId: string };
const host = () => window.location;
const roomUrl = (room: string) =>
  (host().protocol === 'https:' ? 'wss://' : 'ws://') + host().host + '/ws?room=' + encodeURIComponent(room);
const sessionKey = (room: string) => 'pidor:session:' + room;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let penaltyTimer: ReturnType<typeof setTimeout> | undefined;
let verdictTimer: ReturnType<typeof setTimeout> | undefined;
let revealTimer: ReturnType<typeof setTimeout> | undefined;
let retry = 0;
let intentionalDisconnect = false;
let joining: { name: string; room: string; options: JoinOptions } | null = null;

export const useGameStore = defineStore('game', {
  state: () => ({
    socket: null as WebSocket | null,
    connected: false,
    playerId: '' as string,
    playerName: '',
    roomId: '',
    gameState: null as GameState | null,
    lastPenalty: null as { playerId: string; reason: string } | null,
    lastVerdict: null as Verdict | null,
    lastReveal: null as CardDrawReveal | null,
    lastError: '',
    tables: [] as TableListing[],
    roomsLoading: false,
  }),
  actions: {
    connect() { /* Deliberately connect only after the player chooses a room. */ },
    async fetchTables() {
      this.roomsLoading = true;
      try {
        const response = await fetch('/api/rooms', { cache: 'no-store' });
        if (!response.ok) throw new Error('Не удалось получить столы');
        const data = await response.json() as { tables?: TableListing[] };
        this.tables = Array.isArray(data.tables) ? data.tables.filter(table =>
          table.phase === 'LOBBY' && table.visibility === 'public' && table.seats > 0 && table.seats < table.capacity
        ) : [];
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : 'Ошибка загрузки';
      } finally { this.roomsLoading = false; }
    },
    async createTable(options: { title?: string; visibility: 'public' | 'private'; underlaidCards: boolean }): Promise<TableListing | null> {
      try {
        const res = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options) });
        const data = await res.json() as { table?: TableListing; error?: string };
        if (!res.ok || !data.table) throw new Error(data.error || 'Не удалось создать стол');
        return data.table;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Ошибка';
        return null;
      }
    },
    joinRoom(name: string, room: string, options: JoinOptions = {}) {
      if (!/^[A-Za-z0-9_-]{1,48}$/.test(room)) {
        this.lastError = 'Код стола может содержать только латинские буквы, цифры, _ и -';
        return;
      }
      joining = { name, room, options };
      intentionalDisconnect = false;
      this.roomId = room;
      this.playerName = name;
      this.gameState = null;
      this.lastError = '';
      this.openWebSocket();
    },
    openWebSocket() {
      if (!joining) return;
      const { room, name, options } = joining;
      const prior = this.socket;
      if (prior) {
        prior.onclose = null;
        prior.close();
      }
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      const ws = new WebSocket(roomUrl(room));
      this.socket = ws;
      this.connected = false;
      ws.onopen = () => {
        if (this.socket !== ws) return;
        retry = 0;
        this.connected = true;
        const initData = window.Telegram?.WebApp?.initData;
        const sessionToken = localStorage.getItem(sessionKey(room)) || undefined;
        const payload = {
          playerName: name, ...options, ...(initData ? { initData } : {}),
          ...(sessionToken ? { sessionToken } : {}),
        };
        ws.send(JSON.stringify({ type: 'joinRoom', data: payload }));
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', data: {} }));
        }, 23_000);
      };
      ws.onmessage = (event: MessageEvent<string>) => {
        if (this.socket !== ws) return;
        let message: GameMessage;
        try { message = JSON.parse(event.data) as GameMessage; } catch { return; }
        const data = message.data;
        switch (message.type) {
          case 'joined': {
            const result = data as { playerId: string; sessionToken: string; name: string };
            this.playerId = result.playerId;
            this.playerName = result.name;
            localStorage.setItem(sessionKey(room), result.sessionToken);
            break;
          }
          case 'gameStateUpdate': this.gameState = data as GameState; break;
          case 'cardDrawReveal': {
            const reveal = data as CardDrawReveal;
            this.lastReveal = reveal;
            clearTimeout(revealTimer);
            revealTimer = setTimeout(() => { if (this.lastReveal?.id === reveal.id) this.lastReveal = null; }, 1500);
            break;
          }
          case 'penalty': {
            const result = data as { playerId: string; reason: string };
            this.lastPenalty = result;
            clearTimeout(penaltyTimer);
            penaltyTimer = setTimeout(() => { if (this.lastPenalty === result) this.lastPenalty = null; }, 2100);
            break;
          }
          case 'accusationVerdict': {
            const verdict = data as Verdict;
            this.lastVerdict = verdict;
            clearTimeout(verdictTimer);
            verdictTimer = setTimeout(() => { if (this.lastVerdict === verdict) this.lastVerdict = null; }, 2100);
            break;
          }
          case 'actionError':
          case 'joinError': {
            this.lastError = String(data);
            if (message.type === 'joinError') {
              intentionalDisconnect = true;
              ws.close();
            }
            setTimeout(() => { if (this.lastError === String(data)) this.lastError = ''; }, 4000);
            break;
          }
        }
      };
      ws.onclose = () => {
        if (this.socket !== ws) return;
        clearInterval(pingTimer);
        this.connected = false;
        if (!intentionalDisconnect && joining && retry < 15) {
          retry++;
          reconnectTimer = setTimeout(() => this.openWebSocket(), Math.min(12_000, 600 * 1.5 ** retry));
        }
      };
      ws.onerror = () => { if (this.socket === ws) this.lastError = 'Соединение прервано'; };
    },
    disconnect() {
      intentionalDisconnect = true;
      joining = null;
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      this.socket?.close();
      this.socket = null;
      this.connected = false;
      this.playerId = '';
      this.gameState = null;
    },
    send(type: string, payload: Record<string, unknown> = {}) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.playerId) return false;
      this.socket.send(JSON.stringify({ type, data: { ...payload, actionId: crypto.randomUUID() } }));
      return true;
    },
    startGame() { return this.send('startGame'); },
    drawCardFromDeck() { return this.send('drawCardFromDeck'); },
    drawTo(targetPlayerId: string) { return this.send('drawTo', { targetPlayerId }); },
    takeFromPile(cardId: string) { return this.send('takeFromPile', { cardId }); },
    moveTopTo(targetPlayerId: string) { return this.send('moveTopTo', { targetPlayerId }); },
    placeActiveCard(targetPlayerId: string) { return this.send('placeActiveCard', { targetPlayerId }); },
    givePenaltyCard(cardId: string, receiverId: string) { return this.send('givePenaltyCard', { cardId, receiverId }); },
    playCard(cardId: string) { return this.send('playCard', { cardId }); },
    takeTrick() { return this.send('takeTrick'); },
    takeStumps() { return this.send('takeStumps'); },
    exitGame() { return this.send('exitGame'); },
    accusePlayer(accusedId: string) { return this.send('accusePlayer', { accusedId }); },
    finishReview() { return this.send('finishReview'); },
    sayPhrase(phrase: string) { return this.send('sayPhrase', { phrase }); },
  },
});

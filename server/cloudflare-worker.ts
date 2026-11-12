import { DurableObject } from 'cloudflare:workers';
import { PidorGame } from './gameLogic';
import { applyBotMove, nextBotMove } from './botStrategy';
import { handleTelegram } from './telegram';
import { LobbyDirectory } from './lobbyDirectory';
import { createDrawReveal } from './drawReveal';
import type { Card, CardDrawReveal, GameState } from '../shared/types';

interface Env {
  ROOMS: DurableObjectNamespace<PidorRoom>;
  LOBBY: DurableObjectNamespace<LobbyDirectory>;
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}
interface Session { playerId: string; name: string; telegramId?: number; }
interface Connection { playerId?: string; }
type GameSnapshot = ReturnType<PidorGame['snapshot']>;

function emit(socket: WebSocket, type: string, data: unknown) {
  try { socket.send(JSON.stringify({ type, data })); } catch { /* client disconnected */ }
}
function mask(id: string): Card { return { id: 'masked-' + id, rank: '6', suit: 'clubs' }; }
function visibleState(state: GameState, playerId: string): GameState {
  const copy: GameState = structuredClone(state);
  copy.deck = state.deck.map((_, i) => mask('deck-' + i));
  copy.players = copy.players.map(p => {
    const original = state.players.find(x => x.id === p.id)!;
    if (p.id !== playerId) p.hand = original.hand.map((_, i) => mask('hand-' + i));
    // Only the top card of the dealing pile is public. All lower cards,
    // including the human player's own, remain concealed until moved to hand.
    p.stumps = original.stumps.map((card, i) =>
      state.phase === 'DEALING' && i === original.stumps.length - 1 && i >= (state.underlaidCards === false ? 0 : 2)
        ? card : mask('stumps-' + p.id + '-' + i));
    return p;
  });
  // Cards drawn from the common deck are face-up public information:
  // non-drawing players must see the real card while it is being placed.
  return copy;
}
async function verifyTelegram(initData: string, botToken?: string): Promise<{ id: number; first_name?: string; username?: string } | null> {
  if (!botToken || initData.length > 8192) return null;
  try {
    const params = new URLSearchParams(initData);
    const authDate = Number(params.get('auth_date'));
    const hash = params.get('hash') || '';
    if (!/^[0-9a-f]{64}$/i.test(hash)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > 86400) return null;
    const check = [...params.entries()].filter(([k]) => k !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
    const enc = new TextEncoder();
    const key1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = await crypto.subtle.sign('HMAC', key1, enc.encode(botToken));
    const key2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const actual = new Uint8Array(await crypto.subtle.sign('HMAC', key2, enc.encode(check)));
    const expected = new Uint8Array(hash.match(/../g)!.map(x => parseInt(x, 16)));
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    if (diff !== 0) return null;
    const user = JSON.parse(params.get('user') || '{}');
    return Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
  } catch { return null; }
}

export class PidorRoom extends DurableObject<Env> {
  private game = new PidorGame([]);
  private sessions: Record<string, Session> = {};
  private botIds: string[] = [];
  private roomMode: 'friends' | 'bot' = 'friends';
  private roomId = '';
  private idleDeadline = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const [snapshot, sessions, bots, mode, roomId, idleDeadline] = await Promise.all([
        ctx.storage.get<GameSnapshot>('game'),
        ctx.storage.get<Record<string, Session>>('sessions'),
        ctx.storage.get<string[]>('bots'),
        ctx.storage.get<'friends' | 'bot'>('roomMode'),
        ctx.storage.get<string>('roomId'),
        ctx.storage.get<number>('idleDeadline')
      ]);
      if (snapshot) this.game.restore(snapshot);
      if (sessions) this.sessions = sessions;
      if (bots) this.botIds = bots;
      if (mode) this.roomMode = mode;
      if (roomId) this.roomId = roomId;
      if (idleDeadline) this.idleDeadline = idleDeadline;
    });
    this.game.onPenalty = (playerId, reason) => {
      for (const socket of this.ctx.getWebSockets()) {
        emit(socket, 'penalty', { playerId, reason });
        if ((socket.deserializeAttachment() as Connection | null)?.playerId === playerId) {
          emit(socket, 'penaltyAwarded', { reason });
        }
      }
    };
  }

  async fetch(request: Request): Promise<Response> {
    const id = new URL(request.url).searchParams.get('room');
    if (id && /^[A-Za-z0-9_-]{1,48}$/.test(id) && id !== this.roomId) {
      this.roomId = id;
      await this.ctx.storage.put('roomId', id);
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({} satisfies Connection);
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcastDrawReveal(event: CardDrawReveal): void {
    // Every connected spectator/player receives the same actual rank and suit.
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN &&
          (socket.deserializeAttachment() as Connection | null)?.playerId) {
        emit(socket, 'cardDrawReveal', event);
      }
    }
  }

  private broadcast(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const playerId = (socket.deserializeAttachment() as Connection | null)?.playerId;
      if (playerId) {
        const view = visibleState(this.game.state, playerId);
        view.hostId = this.currentHostId();
        if (this.game.state.phase === 'PENALTY_DISTRIBUTION') {
          view.pendingPenaltyDebts = this.game.snapshot().penaltyDebts;
          view.pendingPenaltyTurn = this.game.currentPenaltyTurn();
        }
        emit(socket, 'gameStateUpdate', view);
      }
    }
  }
  private currentHostId(): string | undefined {
    const active = new Set(this.activePlayerIds());
    return this.game.state.players.find(p => active.has(p.id) && !p.isBot)?.id;
  }
  private async forgetLobbySeat(socket: WebSocket): Promise<void> {
    if (this.game.state.phase !== 'LOBBY') return;
    const id = (socket.deserializeAttachment() as Connection | null)?.playerId;
    if (!id || this.activePlayerIds(socket).includes(id)) return;
    this.game.state.players = this.game.state.players.filter(p => p.id !== id);
    for (const [token, session] of Object.entries(this.sessions)) {
      if (session.playerId === id) delete this.sessions[token];
    }
    await Promise.all([
      this.ctx.storage.put('sessions', this.sessions),
      this.saveGame()
    ]);
    this.broadcast();
  }
  private activePlayerIds(exclude?: WebSocket): string[] {
    const ids = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude || socket.readyState !== WebSocket.OPEN) continue;
      const id = (socket.deserializeAttachment() as Connection | null)?.playerId;
      if (id) ids.add(id);
    }
    return [...ids];
  }
  private async reportRoom(): Promise<void> {
    if (!this.roomId || this.roomMode === 'bot') return;
    const ids = new Set(this.activePlayerIds());
    const players = this.game.state.players.filter(p => ids.has(p.id)).map(p => p.name);
    try {
      await this.env.LOBBY.getByName('public-tables').fetch('https://lobby.internal/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: this.roomId, players, phase: this.game.state.phase })
      });
    } catch (e) { console.warn('Lobby sync error', String(e).slice(0,150)); }
  }
  private async clearVacantRoom(): Promise<void> {
    if (this.activePlayerIds().length > 0) return;
    if (this.roomId) {
      try {
        await this.env.LOBBY.getByName('public-tables').fetch('https://lobby.internal/remove', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: this.roomId })
        });
      } catch (e) { console.warn('Lobby cleanup error', String(e).slice(0,150)); }
    }
    const penaltyCallback = this.game.onPenalty;
    this.game = new PidorGame([]);
    this.game.onPenalty = penaltyCallback;
    this.sessions = {};
    this.botIds = [];
    this.roomMode = 'friends';
    this.idleDeadline = 0;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
  private async markActivity(): Promise<void> {
    if (this.activePlayerIds().length) {
      if (this.idleDeadline) {
        this.idleDeadline = 0;
        await this.ctx.storage.delete('idleDeadline');
      }
    } else {
      this.idleDeadline = Date.now() + 75_000;
      await this.ctx.storage.put('idleDeadline', this.idleDeadline);
    }
    await this.driveBots();
  }

  private async saveGame(): Promise<void> {
    await this.ctx.storage.put('game', this.game.snapshot());
  }
  private broadcastVerdict(accuserId: string, verdict: { correct: boolean; accusedId: string; penalizedId: string; reason: string }) {
    for (const socket of this.ctx.getWebSockets()) {
      emit(socket, 'accusationVerdict', { accuserId, ...verdict });
    }
  }
  private announcePenaltyCard(receiverId: string, giverId: string) {
    for (const socket of this.ctx.getWebSockets()) {
      const connection = socket.deserializeAttachment() as Connection | null;
      if (connection?.playerId === receiverId) {
        emit(socket, 'penaltyCardReceived', { giverId });
      }
    }
  }

  private async driveBots(): Promise<void> {
    if (this.idleDeadline && this.activePlayerIds().length === 0) {
      await this.ctx.storage.setAlarm(this.idleDeadline);
      return;
    }
    // The last 15 seconds are reserved for player accusations.
    // Everyone can finish review early, otherwise the server ends it on time.
    if (this.game.state.phase === 'PENALTY_REVIEW' && this.game.reviewDeadlineAt) {
      await this.ctx.storage.setAlarm(this.game.reviewDeadlineAt);
      return;
    }
    if (this.roomMode !== 'bot') {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (nextBotMove(this.game, this.botIds)) {
      await this.ctx.storage.setAlarm(Date.now() + 850);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async alarm(): Promise<void> {
    if (this.idleDeadline && this.activePlayerIds().length === 0) {
      if (Date.now() >= this.idleDeadline) await this.clearVacantRoom();
      else await this.ctx.storage.setAlarm(this.idleDeadline);
      return;
    }
    if (this.game.expireReview()) {
      await this.saveGame();
      this.broadcast();
      await this.driveBots();
      return;
    }
    if (this.roomMode !== 'bot') return;
    const move = nextBotMove(this.game, this.botIds);
    if (!move) {
      await this.driveBots();
      return;
    }
    const drawBefore = move.type === 'drawCardFromDeck' ? this.game.state.deck.length : 0;
    const drawnTop = move.type === 'drawCardFromDeck' ? this.game.state.deck[drawBefore - 1] : undefined;
    const verdict = move.type === 'accuse' ? this.game.accuse(move.actorId, move.accusedId) : null;
    const applied = move.type === 'accuse' ? verdict !== null : applyBotMove(this.game, move);
    if (applied) {
      if (move.type === 'drawCardFromDeck') {
        const reveal = createDrawReveal(move.actorId, drawnTop, drawBefore, this.game.state.deck.length);
        if (reveal) this.broadcastDrawReveal(reveal);
      }
      if (verdict) this.broadcastVerdict(move.actorId, verdict);
      if (move.type === 'givePenaltyCard') this.announcePenaltyCard(move.receiverId, move.actorId);
      await this.saveGame();
      this.broadcast();
    } else {
      console.warn('Bot move rejected', move.type, this.game.state.phase);
    }
    await this.driveBots();
  }

  private async join(socket: WebSocket, payload: Record<string, unknown>) {
    const tgData = typeof payload.initData === 'string' ? payload.initData : '';
    const telegram = tgData ? await verifyTelegram(tgData, this.env.TELEGRAM_BOT_TOKEN) : null;
    if (tgData && !telegram) return emit(socket, 'joinError', 'Telegram: авторизация не подтверждена');
    const rawName = telegram ? telegram.first_name || telegram.username : payload.playerName;
    if (typeof rawName !== 'string' || !rawName.trim() || rawName.length > 32) {
      return emit(socket, 'joinError', 'Введи имя от 1 до 32 символов');
    }
    const existingToken = typeof payload.sessionToken === 'string' ? payload.sessionToken : '';
    let session = existingToken ? this.sessions[existingToken] : undefined;
    if (session && session.telegramId !== undefined && session.telegramId !== telegram?.id) {
      return emit(socket, 'joinError', 'Сессия принадлежит другому игроку Telegram');
    }
    let token = existingToken;
    let createdBotRoom = false;
    // Old abandoned rooms that pre-date automatic cleanup can be reused.
    if (!session && this.game.state.phase !== 'LOBBY' && this.activePlayerIds(socket).length === 0 &&
      (!this.idleDeadline || Date.now() >= this.idleDeadline)) {
      await this.clearVacantRoom();
    }
    if (!session) {
      if (this.game.state.players.length === 0) {
        let useBase = payload.underlaidCards !== false;
        if (payload.mode !== 'bot' && this.roomId) {
          try {
            const response = await this.env.LOBBY.getByName('public-tables').fetch(
              'https://lobby.internal/get?id=' + encodeURIComponent(this.roomId));
            if (response.ok) {
              const record = await response.json() as { table?: { underlaidCards?: boolean } };
              useBase = record.table?.underlaidCards !== false;
            }
          } catch { /* Existing private room without a directory entry */ }
        }
        this.game.state.underlaidCards = useBase;
      }
      if (this.roomMode === 'bot' && this.game.state.players.length) {
        return emit(socket, 'joinError', 'Это одиночная игра. Создай свою комнату с ботом.');
      }
      if (this.game.state.phase !== 'LOBBY') return emit(socket, 'joinError', 'Партия уже идёт — присоединиться нельзя');
      if (this.game.state.players.length >= 6) return emit(socket, 'joinError', 'Комната заполнена');
      token = crypto.randomUUID();
      session = { playerId: crypto.randomUUID(), name: rawName.trim(), telegramId: telegram?.id };
      this.sessions[token] = session;
      this.game.state.players.push({
        id: session.playerId, name: session.name, hand: [], stumps: [], penalties: 0,
        isReady: false, onDuty: false, hasExited: false
      });
      if (this.game.state.players.length === 1 && payload.mode === 'bot') {
        this.roomMode = 'bot';
        createdBotRoom = true;
        const requested = typeof payload.botCount === 'number' ? payload.botCount : 1;
        const count = Math.max(1, Math.min(5, Math.floor(requested || 1)));
        for (let n = 0; n < count; n++) {
          const id = 'bot-' + crypto.randomUUID();
          this.botIds.push(id);
          this.game.state.players.push({
            id, name: count === 1 ? 'Бот Валет' : 'Бот ' + (n + 1),
            hand: [], stumps: [], penalties: 0, isReady: true, onDuty: false, hasExited: false,
            isBot: true
          });
        }
      }
      this.game.state.mode = this.roomMode;
      await Promise.all([
        this.ctx.storage.put('sessions', this.sessions),
        this.ctx.storage.put('bots', this.botIds),
        this.ctx.storage.put('roomMode', this.roomMode)
      ]);
      await this.saveGame();
    }
    for (const other of this.ctx.getWebSockets()) {
      if (other !== socket && (other.deserializeAttachment() as Connection | null)?.playerId === session.playerId) {
        other.close(1000, 'Reconnected in another tab');
      }
    }
    socket.serializeAttachment({ playerId: session.playerId } satisfies Connection);
    this.idleDeadline = 0;
    await this.ctx.storage.delete('idleDeadline');
    emit(socket, 'joined', { playerId: session.playerId, sessionToken: token, name: session.name });
    if (createdBotRoom) {
      this.game.start();
      await this.saveGame();
    }
    this.broadcast();
    await this.reportRoom();
    await this.driveBots();
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > 8192) return;
    let parsed: { type?: string; data?: unknown };
    try { parsed = JSON.parse(message); } catch { return; }
    const type = parsed.type;
    const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
      ? parsed.data as Record<string, unknown> : {};
    if (type === 'joinRoom') { await this.join(socket, data); return; }
    if (type === 'ping') {
      emit(socket, 'pong', Date.now());
      await this.reportRoom();
      return;
    }
    const id = (socket.deserializeAttachment() as Connection | null)?.playerId;
    if (!id || !this.game.state.players.some(p => p.id === id)) {
      return emit(socket, 'joinError', 'Подключись к комнате');
    }
    const game = this.game;
    if (type === 'accusePlayer' && typeof data.accusedId === 'string') {
      const verdict = game.accuse(id, data.accusedId);
      if (verdict) this.broadcastVerdict(id, verdict);
      else emit(socket, 'actionError', 'Обвинение сейчас недоступно');
    }
    else if (type === 'finishReview') {
      if (!game.finishReview(id)) emit(socket, 'actionError', 'Разбор уже завершён');
    }
    else if (type === 'startGame') {
      if (game.state.phase !== 'LOBBY' || game.state.players.length < 2) {
        emit(socket, 'actionError', 'Недостаточно игроков или партия уже началась');
      } else if (this.currentHostId() !== id) {
        emit(socket, 'actionError', 'Партию начинает ведущий стола');
      } else game.start();
    }
    else if (type === 'drawTo' && typeof data.targetPlayerId === 'string') {
      const before = game.state.deck.length;
      const card = game.state.deck[before - 1];
      game.drawTo(id, data.targetPlayerId);
      const reveal = createDrawReveal(id, card, before, game.state.deck.length, data.targetPlayerId);
      if (reveal) this.broadcastDrawReveal(reveal);
    }
    else if (type === 'moveTopTo' && typeof data.targetPlayerId === 'string') game.moveTopTo(id, data.targetPlayerId);
    else if (type === 'drawCardFromDeck') {
      const before = game.state.deck.length;
      const card = game.state.deck[before - 1];
      game.takeFromDeck(id);
      const reveal = createDrawReveal(id, card, before, game.state.deck.length);
      if (reveal) this.broadcastDrawReveal(reveal);
    }
    else if (type === 'takeFromPile' && typeof data.cardId === 'string') game.takeFromPile(id, data.cardId);
    else if (type === 'placeActiveCard' && typeof data.targetPlayerId === 'string') game.placeActiveCard(id, data.targetPlayerId);
    else if (type === 'givePenaltyCard' && typeof data.cardId === 'string' && typeof data.receiverId === 'string') {
      if (game.givePenaltyCard(id, data.cardId, data.receiverId)) {
        this.announcePenaltyCard(data.receiverId, id);
      }
    } else if (type === 'playCard' && typeof data.cardId === 'string') game.playCard(id, data.cardId);
    else if (type === 'takeTrick') game.takeTrick(id);
    else if (type === 'takeStumps') game.takeStumps(id);
    else if (type === 'exitGame') game.exitGame(id);
    else if (type === 'sayPhrase' && typeof data.phrase === 'string' && data.phrase.length <= 120) {
      for (const other of this.ctx.getWebSockets()) emit(other, 'playerMessage', { playerId: id, message: data.phrase });
      return;
    } else return;
    await this.saveGame();
    this.broadcast();
    if (type === 'startGame' || type === 'exitGame') await this.reportRoom();
    await this.driveBots();
  }
  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try { socket.close(code, reason); } catch { /* already closed */ }
    await this.forgetLobbySeat(socket);
    await this.reportRoom();
    await this.markActivity();
  }
  async webSocketError(socket: WebSocket): Promise<void> {
    try { socket.close(1011, 'WebSocket error'); } catch { /* already closed */ }
    await this.forgetLobbySeat(socket);
    await this.reportRoom();
    await this.markActivity();
  }
}
export { LobbyDirectory };
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/telegram/')) return handleTelegram(request, env);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'pidor' });
    if (url.pathname === '/api/rooms') {
      const directory = env.LOBBY.getByName('public-tables');
      if (request.method === 'GET') return directory.fetch('https://lobby.internal/list');
      if (request.method === 'POST') {
        if (Number(request.headers.get('content-length') || 0) > 1024) return new Response('Payload too large', { status: 413 });
        const body = await request.text();
        if (body.length > 1024) return new Response('Payload too large', { status: 413 });
        return directory.fetch('https://lobby.internal/create', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body
        });
      }
      return new Response('Method not allowed', { status: 405 });
    }
    if (url.pathname === '/api/room' && request.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      if (!/^[A-Za-z0-9_-]{1,48}$/.test(id)) return new Response('Bad id', { status: 400 });
      return env.LOBBY.getByName('public-tables').fetch('https://lobby.internal/get?id=' + encodeURIComponent(id));
    }
    if (url.pathname === '/ws') {
      const room = url.searchParams.get('room') || '';
      if (!/^[A-Za-z0-9_-]{1,48}$/.test(room)) return new Response('Invalid room', { status: 400 });
      return env.ROOMS.getByName('room:' + room).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;

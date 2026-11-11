import { DurableObject } from 'cloudflare:workers';
import { PidorGame } from './gameLogic';
import { applyBotMove, nextBotMove } from './botStrategy';
import { handleTelegram } from './telegram';
import type { Card, GameState } from '../shared/types';

interface Env {
  ROOMS: DurableObjectNamespace<PidorRoom>;
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
      state.phase === 'DEALING' && i === original.stumps.length - 1 && i >= 2
        ? card : mask('stumps-' + p.id + '-' + i));
    return p;
  });
  if (copy.activeCard && copy.activeCard.fromDeck && copy.activeCard.ownerId !== playerId) {
    copy.activeCard.card = mask('active');
  }
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const [snapshot, sessions, bots, mode] = await Promise.all([
        ctx.storage.get<GameSnapshot>('game'),
        ctx.storage.get<Record<string, Session>>('sessions'),
        ctx.storage.get<string[]>('bots'),
        ctx.storage.get<'friends' | 'bot'>('roomMode')
      ]);
      if (snapshot) this.game.restore(snapshot);
      if (sessions) this.sessions = sessions;
      if (bots) this.botIds = bots;
      if (mode) this.roomMode = mode;
    });
    this.game.onPenalty = (playerId, reason) => {
      for (const socket of this.ctx.getWebSockets()) {
        emit(socket, 'penalty', { playerId, reason });
      }
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({} satisfies Connection);
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const playerId = (socket.deserializeAttachment() as Connection | null)?.playerId;
      if (playerId) {
        const view = visibleState(this.game.state, playerId);
        if (this.game.state.phase === 'PENALTY_DISTRIBUTION') {
          view.pendingPenaltyDebts = this.game.snapshot().penaltyDebts;
          view.pendingPenaltyTurn = this.game.currentPenaltyTurn();
        }
        emit(socket, 'gameStateUpdate', view);
      }
    }
  }
  private async saveGame(): Promise<void> {
    await this.ctx.storage.put('game', this.game.snapshot());
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
    if (this.roomMode !== 'bot') return;
    // Human sees each opponent action in sequence, not a burst of hundreds.
    // Each alarm performs only one move and then schedules the next turn.
    if (nextBotMove(this.game, this.botIds)) {
      await this.ctx.storage.setAlarm(Date.now() + 850);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async alarm(): Promise<void> {
    if (this.roomMode !== 'bot') return;
    const move = nextBotMove(this.game, this.botIds);
    if (!move) return;
    if (applyBotMove(this.game, move)) {
      if (move.type === 'givePenaltyCard') {
        this.announcePenaltyCard(move.receiverId, move.actorId);
      }
      await this.saveGame();
      this.broadcast();
      await this.driveBots();
    } else {
      console.warn('Bot move rejected', move.type, this.game.state.phase);
    }
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
    if (!session) {
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
        const count = Math.max(1, Math.min(3, Math.floor(requested || 1)));
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
    emit(socket, 'joined', { playerId: session.playerId, sessionToken: token, name: session.name });
    if (createdBotRoom) {
      this.game.start();
      await this.saveGame();
    }
    this.broadcast();
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
    const id = (socket.deserializeAttachment() as Connection | null)?.playerId;
    if (!id || !this.game.state.players.some(p => p.id === id)) {
      return emit(socket, 'joinError', 'Подключись к комнате');
    }
    const game = this.game;
    if (type === 'startGame' && game.state.phase === 'LOBBY' && game.state.players.length >= 2) game.start();
    else if (type === 'drawCardFromDeck') game.takeFromDeck(id);
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
    await this.driveBots();
  }
  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try { socket.close(code, reason); } catch { /* already closed */ }
  }
  async webSocketError(socket: WebSocket): Promise<void> {
    try { socket.close(1011, 'WebSocket error'); } catch { /* already closed */ }
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/telegram/')) return handleTelegram(request, env);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'pidor' });
    if (url.pathname === '/ws') {
      const room = url.searchParams.get('room') || '';
      if (!/^[A-Za-z0-9_-]{1,48}$/.test(room)) return new Response('Invalid room', { status: 400 });
      return env.ROOMS.getByName('room:' + room).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;

import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PidorGame } from './gameLogic.js';
import type { GameState, Card } from '../shared/types.js';

const app = express();
const origins = (process.env.CLIENT_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim());
app.use(cors({ origin: origins }));
app.get('/health', (_req, res) => res.json({ ok: true }));
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: origins, methods: ['GET', 'POST'] } });
const games = new Map<string, PidorGame>();
const sessions = new Map<string, { roomId: string; playerId: string; name: string; telegramId?: number }>();
const connections = new Map<string, { roomId: string; playerId: string }>();
const placeholder = (id: string): Card => ({ id, rank: '6', suit: 'clubs' });

function telegramUser(initData: string): { id: number; first_name?: string; username?: string } | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !initData || initData.length > 8192) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    const authDate = Number(params.get('auth_date'));
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(authDate)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (authDate > now + 60 || now - authDate > 86400) return null;
    const entries = [...params.entries()].filter(([key]) => key !== 'hash').sort(([a], [b]) => a.localeCompare(b));
    const checkString = entries.map(([k, v]) => k + '=' + v).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = createHmac('sha256', secret).update(checkString).digest();
    if (!timingSafeEqual(Buffer.from(hash, 'hex'), expected)) return null;
    const user = JSON.parse(params.get('user') || '{}');
    return Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
  } catch { return null; }
}

function visibleState(state: GameState, playerId: string): GameState {
  const copy: GameState = structuredClone(state);
  copy.deck = copy.deck.map((_, i) => placeholder('deck-' + i));
  copy.players = copy.players.map(p => {
    const real = state.players.find(x => x.id === p.id)!;
    if (p.id !== playerId) p.hand = real.hand.map((_, i) => placeholder('hand-' + p.id + '-' + i));
    p.stumps = real.stumps.map((c, i) =>
      state.phase === 'DEALING' && i >= 2 ? c : placeholder('stump-' + p.id + '-' + i));
    return p;
  });
  if (copy.activeCard && copy.activeCard.fromDeck && copy.activeCard.ownerId !== playerId) {
    // A drawn card is revealed to everyone only after it has been placed.
    copy.activeCard.card = placeholder('active-hidden');
  }
  return copy;
}

function broadcast(roomId: string) {
  const game = games.get(roomId);
  if (!game) return;
  for (const [socketId, connection] of connections) {
    if (connection.roomId === roomId) io.to(socketId).emit('gameStateUpdate', visibleState(game.state, connection.playerId));
  }
}

function identify(socket: Socket, roomId: unknown): { game: PidorGame; id: string } | null {
  const session = connections.get(socket.id);
  if (!session || session.roomId !== roomId) return null;
  const game = games.get(session.roomId);
  return game ? { game, id: session.playerId } : null;
}

io.on('connection', socket => {
  socket.on('joinRoom', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return socket.emit('joinError', 'Неверные данные комнаты');
    const data = payload as { roomId?: unknown; playerName?: unknown; sessionToken?: unknown; initData?: unknown };
    if (typeof data.roomId !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(data.roomId)) {
      return socket.emit('joinError', 'Используй 1–48 букв, цифр, - или _ для названия комнаты');
    }
    const roomId = data.roomId;
    const tg = typeof data.initData === 'string' ? telegramUser(data.initData) : null;
    if (data.initData && !tg) return socket.emit('joinError', 'Авторизация Telegram не прошла проверку');
    const requestedName = tg ? (tg.first_name || tg.username || 'Telegram player') : data.playerName;
    if (typeof requestedName !== 'string' || !requestedName.trim() || requestedName.length > 32) {
      return socket.emit('joinError', 'Имя должно содержать от 1 до 32 символов');
    }
    let token = typeof data.sessionToken === 'string' ? data.sessionToken : '';
    let session = sessions.get(token);
    if (session && (session.roomId !== roomId || (session.telegramId && session.telegramId !== tg?.id))) {
      return socket.emit('joinError', 'Сессия не принадлежит этой комнате');
    }
    if (!session) {
      token = randomUUID();
      session = { roomId, playerId: randomUUID(), name: requestedName.trim(), telegramId: tg?.id };
      sessions.set(token, session);
    }
    if (!games.has(roomId)) {
      const game = new PidorGame([]);
      game.onPenalty = (playerId, reason) => io.to(roomId).emit('penalty', { playerId, reason });
      games.set(roomId, game);
    }
    const game = games.get(roomId)!;
    const existing = game.state.players.find(p => p.id === session!.playerId);
    if (!existing) {
      if (game.state.phase !== 'LOBBY') return socket.emit('joinError', 'Игра уже началась');
      if (game.state.players.length >= 6) return socket.emit('joinError', 'Комната заполнена (максимум 6 игроков)');
      game.state.players.push({ id: session.playerId, name: session.name, hand: [], stumps: [], penalties: 0, isReady: false, onDuty: false, hasExited: false });
    }
    for (const [id, c] of connections) if (c.playerId === session.playerId && c.roomId === roomId && id !== socket.id) {
      io.sockets.sockets.get(id)?.disconnect(true);
      connections.delete(id);
    }
    const previous = connections.get(socket.id);
    if (previous) socket.leave(previous.roomId);
    socket.join(roomId);
    connections.set(socket.id, { roomId, playerId: session.playerId });
    socket.emit('joined', { playerId: session.playerId, sessionToken: token, name: session.name });
    broadcast(roomId);
  });
  socket.on('startGame', roomId => {
    const s = identify(socket, roomId);
    if (s && s.game.state.phase === 'LOBBY' && s.game.state.players.length >= 2) {
      s.game.start(); broadcast(roomId);
    }
  });
  socket.on('drawCardFromDeck', ({ roomId } = {}) => {
    const s = identify(socket, roomId); if (s) { s.game.takeFromDeck(s.id); broadcast(roomId); }
  });
  socket.on('takeFromPile', ({ roomId, cardId } = {}) => {
    const s = identify(socket, roomId); if (s && typeof cardId === 'string') { s.game.takeFromPile(s.id, cardId); broadcast(roomId); }
  });
  socket.on('placeActiveCard', ({ roomId, targetPlayerId } = {}) => {
    const s = identify(socket, roomId); if (s && typeof targetPlayerId === 'string') { s.game.placeActiveCard(s.id, targetPlayerId); broadcast(roomId); }
  });
  socket.on('givePenaltyCard', ({ roomId, cardId, receiverId } = {}) => {
    const s = identify(socket, roomId);
    if (s && typeof cardId === 'string' && typeof receiverId === 'string') { s.game.givePenaltyCard(s.id, cardId, receiverId); broadcast(roomId); }
  });
  socket.on('playCard', ({ roomId, cardId } = {}) => {
    const s = identify(socket, roomId); if (s && typeof cardId === 'string') { s.game.playCard(s.id, cardId); broadcast(roomId); }
  });
  socket.on('takeTrick', ({ roomId } = {}) => {
    const s = identify(socket, roomId); if (s) { s.game.takeTrick(s.id); broadcast(roomId); }
  });
  socket.on('takeStumps', ({ roomId } = {}) => {
    const s = identify(socket, roomId); if (s) { s.game.takeStumps(s.id); broadcast(roomId); }
  });
  socket.on('exitGame', ({ roomId } = {}) => {
    const s = identify(socket, roomId); if (s) { s.game.exitGame(s.id); broadcast(roomId); }
  });
  socket.on('sayPhrase', ({ roomId, phrase } = {}) => {
    const s = identify(socket, roomId);
    if (s && typeof phrase === 'string' && phrase.length < 120) io.to(roomId).emit('playerMessage', { playerId: s.id, message: phrase });
  });
  socket.on('disconnect', () => connections.delete(socket.id));
});

const PORT = Number(process.env.PORT || 3001);
httpServer.listen(PORT, () => console.log('PIDOR server on port ' + PORT));

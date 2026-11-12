import { DurableObject } from 'cloudflare:workers';
import { PidorGame } from './gameLogic';
import { applyBotMove, nextBotMove } from './botStrategy';
import { handleTelegram } from './telegram';
import { LobbyDirectory } from './lobbyDirectory';
import { createDrawReveal } from './drawReveal';
import { visibleState } from './visibility';
import { rememberAction, STATE_CHANGING_ACTIONS, type ActionHistory } from './actionReplay';
import type { CardDrawReveal, GameState } from '../shared/types';

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
  private processedActions: ActionHistory = {};

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const [snapshot, sessions, bots, mode, roomId, idleDeadline, processedActions] = await Promise.all([
        ctx.storage.get<GameSnapshot>('game'),
        ctx.storage.get<Record<string, Session>>('sessions'),
        ctx.storage.get<string[]>('bots'),
        ctx.storage.get<'friends' | 'bot'>('roomMode'),
        ctx.storage.get<string>('roomId'),
        ctx.storage.get<number>('idleDeadline'),
        ctx.storage.get<ActionHistory>('processedActions')
      ]);
      if (snapshot) this.game.restore(snapshot);
      if (sessions) this.sessions = sessions;
      if (bots) this.botIds = bots;
      if (mode) this.roomMode = mode;
      if (roomId) this.roomId = roomId;
      if (idleDeadline) this.idleDeadline = idleDeadline;
      if (processedActions) this.processedActions = processedActions;
    });
    --- TRUNCATED --- 23,793 chars
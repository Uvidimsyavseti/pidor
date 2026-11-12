import { DurableObject } from 'cloudflare:workers';

export interface TableListing {
  id: string;
  title: string;
  visibility: 'public' | 'private';
  underlaidCards?: boolean;
  phase: 'LOBBY' | 'DEALING' | 'PENALTY_REVIEW' | 'PENALTY_DISTRIBUTION' | 'MAIN_GAME' | 'ENDED';
  seats: number;
  capacity: number;
  players: string[];
  createdAt: number;
  updatedAt: number;
}

const STALE_AFTER_MS = 90_000;
const MAX_TABLES = 150;
function cleanName(input: unknown): string {
  if (typeof input !== 'string') return 'Стол у камина';
  return input.trim().replace(/\s+/g, ' ').slice(0, 36) || 'Стол у камина';
}

/**
 * Singleton Durable Object serves as the public table registry.
 * Active rooms report status; no game cards, session tokens, or Telegram IDs
 * are ever stored here.
 */
export class LobbyDirectory extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    const previous = await this.ctx.storage.get<TableListing[]>('tables') || [];
    const tables = previous.filter(room => now - room.updatedAt < STALE_AFTER_MS && room.seats > 0 ||
      now - room.createdAt < STALE_AFTER_MS && room.seats === 0);
    if (tables.length !== previous.length) await this.ctx.storage.put('tables', tables);

    if (url.pathname === '/list' && request.method === 'GET') {
      const free = tables
        .filter(t => t.visibility === 'public' && t.phase === 'LOBBY' && t.seats > 0 && t.seats < t.capacity)
        .sort((a, b) => b.seats - a.seats || b.updatedAt - a.updatedAt);
      return Response.json({ tables: free.slice(0, 40), updatedAt: now }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/create' && request.method === 'POST') {
      if (tables.length >= MAX_TABLES) {
        return Response.json({ error: 'Все столы временно заняты. Повтори попытку.' }, { status: 429 });
      }
      const data = await request.json().catch(() => ({})) as { title?: string; visibility?: string; underlaidCards?: boolean };
      const id = 't_' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
      const table: TableListing = {
        id, title: cleanName(data.title),
        visibility: data.visibility === 'private' ? 'private' : 'public',
        underlaidCards: data.underlaidCards !== false,
        phase: 'LOBBY', seats: 0, capacity: 6, players: [],
        createdAt: now, updatedAt: now
      };
      tables.push(table);
      await this.ctx.storage.put('tables', tables);
      await this.ctx.storage.setAlarm(now + STALE_AFTER_MS);
      return Response.json({ table }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/get' && request.method === 'GET') {
      const table = tables.find(t => t.id === url.searchParams.get('id'));
      return table ? Response.json({ table }) : Response.json({ error: 'Стол не найден' }, { status: 404 });
    }
    if (url.pathname === '/sync' && request.method === 'POST') {
      const data = await request.json() as Partial<TableListing>;
      if (!data.id || !/^[a-zA-Z0-9_-]{1,48}$/.test(data.id)) return new Response('Bad room', { status: 400 });
      const index = tables.findIndex(t => t.id === data.id);
      const current = index >= 0 ? tables[index] : {
        id: data.id, title: 'Стол ' + data.id.slice(-6),
        visibility: 'private' as const, phase: 'LOBBY' as const, seats: 0,
        capacity: 6, players: [], createdAt: now, updatedAt: now
      };
      const connected = Array.isArray(data.players)
        ? data.players.filter(p => typeof p === 'string' && p.length <= 32).slice(0, 6) : [];
      const next: TableListing = {
        ...current,
        seats: connected.length,
        players: connected,
        phase: data.phase || current.phase,
        updated --- TRUNCATED --- 4,832 chars
/**
 * Gesture targeting for the communal deck. Geometry is expressed in viewport
 * CSS pixels; time is performance.now() in milliseconds.
 *
 * A slow gesture must END on a player's card seat. A quick swipe may be thrown
 * along its velocity vector, but only if the ray actually crosses a seat.
 * No auto-assignment to the nearest player: cheating remains an explicit act.
 */
export interface GesturePoint { x: number; y: number; t: number; }
export interface ThrowRect { left: number; top: number; right: number; bottom: number; }
export interface ThrowSeat { id: string; rect: ThrowRect; }
export interface GestureResult {
  targetId: string | null;
  kind: 'drop' | 'flick' | 'cancel';
  speed: number;
}

export const FLICK_SPEED_PX_MS = 0.82; // 820 px/s
export const FLICK_MIN_DISTANCE_PX = 42;
const RECENT_MS = 125;
const PROJECT_MS = 370;
const MIN_RANGE_PX = 190;
const MAX_RANGE_PX = 920;
const EDGE_TOLERANCE_PX = 14;

export function gestureVelocity(points: readonly GesturePoint[]): {vx:number;vy:number;speed:number} {
  if (points.length < 2) return {vx:0,vy:0,speed:0};
  const last = points[points.length - 1]!;
  let first = points[0]!;
  for (let i = points.length - 2; i >= 0; i--) {
    if (last.t - points[i]!.t > RECENT_MS) break;
    first = points[i]!;
  }
  const dt = last.t - first.t;
  if (dt < 8) return {vx:0,vy:0,speed:0};
  const vx = (last.x - first.x) / dt;
  const vy = (last.y - first.y) / dt;
  return {vx,vy,speed:Math.hypot(vx,vy)};
}

function inRect(p: GesturePoint, r: ThrowRect): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/** Ray / expanded rectangle intersection, measured forward from the finger. */
function rayEntry(
  origin: GesturePoint, ux: number, uy: number, rect: ThrowRect
): number | null {
  const r = {
    left: rect.left - EDGE_TOLERANCE_PX,
    top: rect.top - EDGE_TOLERANCE_PX,
    right: rect.right + EDGE_TOLERANCE_PX,
    bottom: rect.bottom + EDGE_TOLERANCE_PX
  };
  let near = 0, far = Infinity;
  const axes: Array<[number,number,number,number]> = [
    [origin.x, ux, r.left, r.right],
    [origin.y, uy, r.top, r.bottom]
  ];
  for (const [axis, unit, min, max] of axes) {
    if (Math.abs(unit) < 1e-6) {
      if (axis < min || axis > max) return null;
    } else {
      let a = (min - axis) / unit, b = (max - axis) / unit;
      if (a > b) [a,b] = [b,a];
      near = Math.max(near, a);
      far = Math.min(far,b);
      if (far < near) return null;
    }
  }
  return near;
}

export function resolveCardGesture(
  points: readonly GesturePoint[],
  seats: readonly ThrowSeat[],
  excludedIds: readonly string[] = []
): GestureResult {
  const last = points[points.length - 1];
  if (!last) return {targetId:null,kind:'cancel',speed:0};
  const candidates = seats.filter(s => !excludedIds.includes(s.id));
  const {vx,vy,speed} = gestureVelocity(points);
  // A deliberate drop takes priority even when the finger had momentum.
  const directlyUnder = candidates.find(s => inRect(last,s.rect));
  if (directlyUnder) return {targetId:directlyUnder.id,kind:'drop',speed};

  const start = points[0]!;
  if (speed < FLICK_SPEED_PX_MS ||
      Math.hypot(last.x-start.x,last.y-start.y) < FLICK_MIN_DISTANCE_PX) {
    return {targetId:null,kind:'cancel',speed};
  }
  const ux = vx / speed, uy = vy / speed;
  const distance = Math.min(MAX_RANGE_PX, Math.max(MIN_RANGE_PX,speed * PROJECT_MS));
  let choice: {id:string;at:number} | null = null;
  for (const seat of candidates) {
    const entry = rayEntry(last,ux,uy,seat.rect);
    if (entry === null || entry > distance) continue;
    if (!choice || entry < choice.at) choice = {id:seat.id,at:entry};
  }
  return choice ? {targetId:choice.id,kind:'flick',speed} :
    {targetId:null,kind:'cancel',speed};
}

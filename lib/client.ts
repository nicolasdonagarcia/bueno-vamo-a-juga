'use client';
// Browser-side helpers: the API, saved identities, and the polling hook every page uses.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicMatch, PublicPlayer, PublicTournament } from './tournament';

export type View = PublicTournament & {
  online: Record<string, boolean>; you: string | null; now: number;
  forToken: string | null;      // the token this answer was fetched with (client side)
};
export type Profile = { name: string; flag: string; color: string };
export type SavedPlayer = { token: string; playerId: string };

// test builds only (NEXT_PUBLIC_BOTS=1): ?bot=0.7 lets the CPU play a seat
export const BOTS_ALLOWED = process.env.NEXT_PUBLIC_BOTS === '1';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new ApiError('No connection. Check your network and try again.', 0);
  }
  let j: unknown = null;
  try { j = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    const msg = j && typeof j === 'object' && 'error' in j ? String((j as { error: unknown }).error) : 'Something went wrong (' + r.status + ').';
    throw new ApiError(msg, r.status);
  }
  return j as T;
}

/* ---------------- saved identities (this browser only) ---------------- */
function read<T>(k: string): T | null {
  try { const s = localStorage.getItem(k); return s ? JSON.parse(s) as T : null; } catch { return null; }
}
function write(k: string, v: unknown) {
  try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ }
}
export const saved = {
  player: (code: string) => read<SavedPlayer>('cc:player:' + code),
  setPlayer: (code: string, v: SavedPlayer | null) => write('cc:player:' + code, v),
  admin: (code: string) => read<string>('cc:admin:' + code),
  setAdmin: (code: string, key: string | null) => write('cc:admin:' + code, key),
  profile: () => read<Profile>('cc:profile'),
  setProfile: (p: Profile) => write('cc:profile', p)
};

// what this browser knows about a cup; `ready` turns true after the first read
export function useIdentity(code: string) {
  const [state, setState] = useState<{ ready: boolean; player: SavedPlayer | null; admin: string | null }>({ ready: false, player: null, admin: null });
  useEffect(() => {
    setState({ ready: true, player: saved.player(code), admin: saved.admin(code) });
  }, [code]);
  const setPlayer = useCallback((p: SavedPlayer | null) => {
    saved.setPlayer(code, p);
    setState(s => ({ ...s, player: p }));
  }, [code]);
  const setAdmin = useCallback((k: string | null) => {
    saved.setAdmin(code, k);
    setState(s => ({ ...s, admin: k }));
  }, [code]);
  return { ...state, setPlayer, setAdmin };
}

/* ---------------- the tournament, polled ---------------- */
export function useTournament(code: string, token: string | null, opts?: { every?: number; enabled?: boolean }) {
  const every = opts?.every ?? 2000;
  const enabled = opts?.enabled ?? true;
  const [t, setT] = useState<View | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const seq = useRef(0), applied = useRef(0), polls = useRef(0);
  const finished = useRef(false);

  const refresh = useCallback(async () => {
    const n = ++seq.current;
    try {
      // presence ("online" dots) only needs a refresh every few polls
      const touch = polls.current++ % 4 === 0;
      const v = await api<View>('/api/t/' + encodeURIComponent(code) + (token ? '?me=' + encodeURIComponent(token) + (touch ? '' : '&t=0') : ''));
      finished.current = v.status === 'finished';
      if (n < applied.current) return;
      applied.current = n;
      setT({ ...v, forToken: token }); setError(null);
    } catch (e) {
      if (n < applied.current) return;
      applied.current = n;
      // a blip keeps the last good state on screen; a missing cup replaces it
      setError(e instanceof ApiError ? e : new ApiError(String(e), 0));
      if (e instanceof ApiError && e.status === 404) setT(null);
    }
  }, [code, token]);

  useEffect(() => {
    if (!enabled) return;
    let stop = false, timer = 0, busy = false, again = false;
    const run = async () => {
      if (busy) { again = true; return; }
      busy = true; clearTimeout(timer);
      await refresh();
      busy = false;
      if (stop) return;
      if (again) { again = false; run(); return; }
      // a cup that is over, or a tab in the background, only needs the odd look
      timer = window.setTimeout(run, finished.current ? 30000 : document.hidden ? Math.max(every, 15000) : every);
    };
    run();
    const onVis = () => { if (!document.hidden && !stop) run(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stop = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh, every, enabled]);

  return { t, error, refresh };
}

/* ---------------- small lookups ---------------- */
export function playerOf(t: PublicTournament | null, id: string | null | undefined): PublicPlayer | null {
  if (!t || !id) return null;
  return t.players.find(p => p.id === id) || null;
}
export function matchOf(t: PublicTournament | null, id: string): PublicMatch | null {
  return t ? t.matches.find(m => m.id === id) || null : null;
}
// the other match feeding the next one I am waiting in
export function feederOf(t: PublicTournament, m: PublicMatch, me: string): PublicMatch | null {
  if (m.round <= 1) return null;
  const feeders = t.matches.filter(x => x.round === m.round - 1 && Math.floor(x.index / 2) === m.index);
  return feeders.find(x => x.a !== me && x.b !== me && x.winner !== me) || null;
}

export type MyStatus =
  | { kind: 'none' }
  | { kind: 'play'; m: PublicMatch }
  | { kind: 'waiting'; m: PublicMatch; feeder: PublicMatch | null }
  | { kind: 'out'; m: PublicMatch }
  | { kind: 'champion'; m: PublicMatch };

export function myStatus(t: PublicTournament, me: string | null): MyStatus {
  if (!me || t.status === 'lobby') return { kind: 'none' };
  const mine = t.matches.filter(m => m.a === me || m.b === me).sort((a, b) => b.round - a.round);
  const m = mine[0];
  if (!m) return { kind: 'none' };
  if (m.status === 'ready' || m.status === 'live') return { kind: 'play', m };
  if (m.status === 'done') {
    if (m.winner === me) return m.round === t.rounds ? { kind: 'champion', m } : { kind: 'waiting', m, feeder: null };
    return { kind: 'out', m };
  }
  return { kind: 'waiting', m, feeder: feederOf(t, m, me) };
}

let icePromise: Promise<RTCIceServer[]> | null = null;
export function getIce(): Promise<RTCIceServer[]> {
  if (!icePromise) {
    icePromise = api<{ iceServers: RTCIceServer[] }>('/api/ice')
      .then(j => j.iceServers || [])
      .catch(() => { icePromise = null; return [{ urls: 'stun:stun.l.google.com:19302' }]; });
  }
  return icePromise;
}

export function fmtTime(sec: number) {
  if (!sec) return 'no limit';
  const m = Math.floor(sec / 60), s = sec % 60;
  return s ? m + ':' + String(s).padStart(2, '0') + ' min' : m + ' min';
}
export function rulesLine(r: { goals: number; capSec: number }) {
  return 'First to ' + r.goals + (r.capSec ? ' · ' + fmtTime(r.capSec) + ' cap, then golden goal' : '');
}
export function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }
export function absUrl(path: string) {
  return typeof window === 'undefined' ? path : window.location.origin + path;
}

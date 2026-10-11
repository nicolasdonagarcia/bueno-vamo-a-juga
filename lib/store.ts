// Storage: one JSON document per tournament plus small signaling mailboxes.
// Production uses Upstash Redis (Vercel Marketplace). Without its env vars the
// app falls back to memory, which only works for a single local server.
import { Redis } from '@upstash/redis';
import type { Tournament } from './tournament';

const DAY = 86400;
const DOC_TTL = 30 * DAY, SIG_TTL = 3 * 3600, SEEN_TTL = 25;

export type Signal = { i: number; at: number; from: string; type: string; session?: string; inst?: string; sdp?: string };

export interface Store {
  kind: 'redis' | 'memory';
  create(doc: Tournament): Promise<boolean>;
  get(code: string): Promise<Tournament | null>;
  update(code: string, fn: (doc: Tournament) => Tournament | null): Promise<Tournament | null>;
  pushSignal(code: string, match: string, box: string, msg: Omit<Signal, 'i'>): Promise<number>;
  readSignals(code: string, match: string, box: string, after: number): Promise<{ msgs: Signal[]; last: number }>;
  touch(code: string, playerId: string): Promise<void>;
  online(code: string, ids: string[]): Promise<Record<string, boolean>>;
}

const CAS = `if redis.call('GET', KEYS[2]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  redis.call('SET', KEYS[2], tostring(tonumber(ARGV[1]) + 1), 'EX', ARGV[3])
  return 1
end
return 0`;

function redisStore(url: string, token: string): Store {
  const r = new Redis({ url, token, automaticDeserialization: false });
  const dk = (c: string) => 'cc:t:' + c, vk = (c: string) => 'cc:t:' + c + ':v';
  const sk = (c: string, m: string, b: string) => 'cc:s:' + c + ':' + m + ':' + b;
  const pk = (c: string, p: string) => 'cc:p:' + c + ':' + p;
  return {
    kind: 'redis',
    async create(doc) {
      const ok = await r.set(dk(doc.code), JSON.stringify(doc), { nx: true, ex: DOC_TTL });
      if (!ok) return false;
      await r.set(vk(doc.code), '1', { ex: DOC_TTL });
      return true;
    },
    async get(code) {
      const s = await r.get<string>(dk(code));
      return s ? JSON.parse(s) as Tournament : null;
    },
    async update(code, fn) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const [s, v] = await r.mget<[string | null, string | null]>(dk(code), vk(code));
        if (!s || !v) return null;
        const next = fn(JSON.parse(s) as Tournament);
        if (!next) return JSON.parse(s) as Tournament;
        const ok = await r.eval(CAS, [dk(code), vk(code)], [v, JSON.stringify(next), String(DOC_TTL)]);
        if (Number(ok) === 1) return next;
        await new Promise(res => setTimeout(res, 15 + Math.random() * 60));
      }
      throw new Error('busy');
    },
    async pushSignal(code, match, box, msg) {
      const key = sk(code, match, box);
      const len = await r.rpush(key, JSON.stringify(msg));
      await r.expire(key, SIG_TTL);
      return len - 1;
    },
    async readSignals(code, match, box, after) {
      const key = sk(code, match, box);
      const items = await r.lrange<string>(key, after + 1, -1);
      const msgs = items.map((s, k) => Object.assign(JSON.parse(s), { i: after + 1 + k }) as Signal);
      return { msgs, last: after + items.length };
    },
    async touch(code, id) { await r.set(pk(code, id), '1', { ex: SEEN_TTL }); },
    async online(code, ids) {
      if (!ids.length) return {};
      const vals = await r.mget<(string | null)[]>(...ids.map(id => pk(code, id)));
      const out: Record<string, boolean> = {};
      ids.forEach((id, i) => { out[id] = !!vals[i]; });
      return out;
    }
  };
}

type Mem = { docs: Map<string, { doc: string; ver: number }>; sig: Map<string, string[]>; seen: Map<string, number> };
function memoryStore(): Store {
  const g = globalThis as unknown as { __ccMem?: Mem };
  const m: Mem = g.__ccMem || (g.__ccMem = { docs: new Map(), sig: new Map(), seen: new Map() });
  return {
    kind: 'memory',
    async create(doc) {
      if (m.docs.has(doc.code)) return false;
      m.docs.set(doc.code, { doc: JSON.stringify(doc), ver: 1 });
      return true;
    },
    async get(code) { const e = m.docs.get(code); return e ? JSON.parse(e.doc) : null; },
    async update(code, fn) {
      const e = m.docs.get(code);
      if (!e) return null;
      const next = fn(JSON.parse(e.doc));
      if (!next) return JSON.parse(e.doc);
      m.docs.set(code, { doc: JSON.stringify(next), ver: e.ver + 1 });
      return next;
    },
    async pushSignal(code, match, box, msg) {
      const key = code + ':' + match + ':' + box;
      const list = m.sig.get(key) || [];
      list.push(JSON.stringify(msg));
      m.sig.set(key, list);
      return list.length - 1;
    },
    async readSignals(code, match, box, after) {
      const list = m.sig.get(code + ':' + match + ':' + box) || [];
      const items = list.slice(after + 1);
      return { msgs: items.map((s, k) => Object.assign(JSON.parse(s), { i: after + 1 + k })), last: after + items.length };
    },
    async touch(code, id) { m.seen.set(code + ':' + id, Date.now()); },
    async online(code, ids) {
      const out: Record<string, boolean> = {};
      for (const id of ids) out[id] = Date.now() - (m.seen.get(code + ':' + id) || 0) < SEEN_TTL * 1000;
      return out;
    }
  };
}

let store: Store | null = null;
export function getStore(): Store {
  if (store) return store;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  store = url && token ? redisStore(url, token) : memoryStore();
  return store;
}
// on Vercel the memory store would give every server instance its own data
export function storeProblem(): string | null {
  const s = getStore();
  if (s.kind === 'memory' && process.env.VERCEL) return 'Storage is not set up. Add Upstash for Redis to this project in the Vercel dashboard (Storage tab) and redeploy.';
  return null;
}

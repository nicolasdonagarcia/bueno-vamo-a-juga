// Storage: one JSON document per tournament plus small signaling mailboxes.
//   REDIS_URL        a plain Redis (the droplet runs one next to the app; redis://127.0.0.1:6379)
//   KV_REST_API_URL  Upstash's REST API (Vercel's Marketplace), with KV_REST_API_TOKEN
//   neither          memory: fine for one server on your own computer, gone when it stops
import { Redis } from '@upstash/redis';
import { createClient } from '@redis/client';
import type { Tournament } from './tournament';

const DAY = 86400;
const DOC_TTL = 30 * DAY, SIG_TTL = 3 * 3600, SEEN_TTL = 25;

export type Signal = { i: number; at: number; from: string; type: string; session?: string; inst?: string; sdp?: string };

export interface Store {
  kind: 'redis' | 'upstash' | 'memory';
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

const dk = (c: string) => 'cc:t:' + c, vk = (c: string) => 'cc:t:' + c + ':v';
const sk = (c: string, m: string, b: string) => 'cc:s:' + c + ':' + m + ':' + b;
const pk = (c: string, p: string) => 'cc:p:' + c + ':' + p;
const pause = (attempt: number) => new Promise(res => setTimeout(res, (10 + Math.random() * 40) * Math.min(attempt + 1, 6)));

// A plain Redis over its own protocol (the same keys and compare-and-swap script as Upstash).
// Commands fail at once while it is unreachable, so a page shows "connection trouble" rather
// than hanging; the client keeps reconnecting by itself.
type Plain = { isOpen: boolean; connect(): Promise<unknown>; sendCommand(args: string[]): Promise<unknown> };
type PlainBox = { url: string; client: Plain; connecting: Promise<unknown> | null };
function plainRedisStore(url: string): Store {
  const g = globalThis as unknown as { __ccRedis?: PlainBox };
  if (!g.__ccRedis || g.__ccRedis.url !== url) {
    const client = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 4000, reconnectStrategy: (n: number) => Math.min(200 * (n + 1), 3000) } });
    let last = 0;
    client.on('error', (e: Error) => { if (Date.now() - last > 30000) { last = Date.now(); console.error('[redis] ' + e.message); } });
    g.__ccRedis = { url, client: client as unknown as Plain, connecting: null };
  }
  const box: PlainBox = g.__ccRedis;
  async function cmd(args: string[]): Promise<unknown> {
    const c = box.client;
    if (!c.isOpen) {
      if (!box.connecting) box.connecting = c.connect().catch(e => { box.connecting = null; throw e; });
      await Promise.race([box.connecting, new Promise((_, no) => setTimeout(() => no(new Error('Redis is not answering')), 4000))]);
    }
    return c.sendCommand(args);
  }
  const str = (x: unknown) => x == null ? null : String(x);
  return {
    kind: 'redis',
    async create(doc) {
      const ok = await cmd(['SET', dk(doc.code), JSON.stringify(doc), 'NX', 'EX', String(DOC_TTL)]);
      if (!ok) return false;
      await cmd(['SET', vk(doc.code), '1', 'EX', String(DOC_TTL)]);
      return true;
    },
    async get(code) {
      const s = str(await cmd(['GET', dk(code)]));
      return s ? JSON.parse(s) as Tournament : null;
    },
    async update(code, fn) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const [s0, v0] = await cmd(['MGET', dk(code), vk(code)]) as unknown[];
        const s = str(s0), v = str(v0);
        if (!s || !v) return null;
        const next = fn(JSON.parse(s) as Tournament);
        if (!next) return JSON.parse(s) as Tournament;
        const ok = await cmd(['EVAL', CAS, '2', dk(code), vk(code), v, JSON.stringify(next), String(DOC_TTL)]);
        if (Number(ok) === 1) return next;
        await pause(attempt);
      }
      throw new Error('busy');
    },
    async pushSignal(code, match, box2, msg) {
      const key = sk(code, match, box2);
      const len = Number(await cmd(['RPUSH', key, JSON.stringify(msg)]));
      await cmd(['EXPIRE', key, String(SIG_TTL)]);
      return len - 1;
    },
    async readSignals(code, match, box2, after) {
      const items = (await cmd(['LRANGE', sk(code, match, box2), String(after + 1), '-1']) as unknown[]).map(x => String(x));
      return { msgs: items.map((s, k) => Object.assign(JSON.parse(s), { i: after + 1 + k }) as Signal), last: after + items.length };
    },
    async touch(code, id) { await cmd(['SET', pk(code, id), '1', 'EX', String(SEEN_TTL)]); },
    async online(code, ids) {
      if (!ids.length) return {};
      const vals = await cmd(['MGET', ...ids.map(id => pk(code, id))]) as unknown[];
      const out: Record<string, boolean> = {};
      ids.forEach((id, i) => { out[id] = vals[i] != null; });
      return out;
    }
  };
}

function redisStore(url: string, token: string): Store {
  const r = new Redis({ url, token, automaticDeserialization: false });
  return {
    kind: 'upstash',
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
      // compare-and-swap: another writer got in first, so wait a little (longer each time) and redo it
      for (let attempt = 0; attempt < 30; attempt++) {
        const [s, v] = await r.mget<[string | null, string | null]>(dk(code), vk(code));
        if (!s || !v) return null;
        const next = fn(JSON.parse(s) as Tournament);
        if (!next) return JSON.parse(s) as Tournament;
        const ok = await r.eval(CAS, [dk(code), vk(code)], [v, JSON.stringify(next), String(DOC_TTL)]);
        if (Number(ok) === 1) return next;
        await pause(attempt);
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
  const plain = process.env.REDIS_URL;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  store = plain ? plainRedisStore(plain) : url && token ? redisStore(url, token) : memoryStore();
  if (store.kind === 'memory' && process.env.NODE_ENV === 'production' && !process.env.VERCEL) {
    console.warn('[store] No REDIS_URL: cups are kept in memory and are lost when the app restarts.');
  }
  return store;
}
// on Vercel the memory store would give every server instance its own data
export function storeProblem(): string | null {
  const s = getStore();
  if (s.kind === 'memory' && process.env.VERCEL) return 'Storage is not set up. Add Upstash for Redis to this project in the Vercel dashboard (Storage tab) and redeploy.';
  return null;
}

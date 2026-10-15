import { createHash, randomBytes } from 'crypto';
import type { Tournament, Player } from './tournament';
import { getStore, storeProblem } from './store';
import { CODE_CHARS, normCode } from './code';

export function hash(s: string) { return createHash('sha256').update(s).digest('hex'); }
export function secret() { return randomBytes(18).toString('base64url'); }
export function id() { return randomBytes(6).toString('base64url'); }

export { normCode } from './code';
export function newCode(len = 5) {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
  return s;
}

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
export function fail(message: string, status = 400) { return json({ error: message }, status); }
// a write that kept losing the race to other writes (Redis compare-and-swap): the page retries or the person tries again
export function busy() { return fail('Too many changes at the same moment. Try again.', 503); }

export async function body(req: Request): Promise<Record<string, unknown>> {
  try { const b = await req.json(); return b && typeof b === 'object' ? b as Record<string, unknown> : {}; } catch { return {}; }
}

export function playerByToken(t: Tournament, token: unknown): Player | null {
  if (typeof token !== 'string' || !token) return null;
  const h = hash(token);
  return t.players.find(p => p.tokenHash === h) || null;
}
export function isAdmin(t: Tournament, key: unknown) { return typeof key === 'string' && !!key && hash(key) === t.adminKeyHash; }

export async function loadOr404(code: string) {
  const problem = storeProblem();
  if (problem) return { error: fail(problem, 503) };
  const t = await getStore().get(normCode(code));
  if (!t) return { error: fail('No tournament with that code.', 404) };
  return { t };
}

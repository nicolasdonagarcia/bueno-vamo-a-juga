// Join (or update your name, flag and colour while the lobby is open).
import { getStore } from '@/lib/store';
import { MAX_PLAYERS, cleanName, type Tournament } from '@/lib/tournament';
import { COLORS } from '@/lib/engine/shared';
import { FLAG_CODES } from '@/lib/flags';
import { body, busy, fail, hash, id, json, loadOr404, playerByToken, secret } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const r = await loadOr404(code);
  if (r.error) return r.error;
  const b = await body(req);
  const name = cleanName(b.name);
  if (!name) return fail('Enter a name.');
  const flag = typeof b.flag === 'string' && FLAG_CODES.has(b.flag) ? b.flag : '';
  const color = COLORS.some(c => c.id === b.color) ? String(b.color) : COLORS[0].id;
  let token = typeof b.token === 'string' ? b.token : '';
  let playerId = '';
  let error = '';
  const t = await getStore().update(r.t.code, (doc: Tournament) => {
    const mine = playerByToken(doc, token);
    if (mine) {
      if (doc.status !== 'lobby') { playerId = mine.id; return null; }
      mine.name = uniqueName(doc, name, mine.id); mine.flag = flag; mine.color = color;
      playerId = mine.id;
      return doc;
    }
    if (doc.status !== 'lobby') { error = 'This tournament has already started.'; return null; }
    if (doc.players.length >= MAX_PLAYERS) { error = 'The tournament is full.'; return null; }
    token = secret();
    playerId = id();
    doc.players.push({ id: playerId, name: uniqueName(doc, name, ''), flag, color, tokenHash: hash(token), joinedAt: Date.now() });
    return doc;
  }).catch(() => undefined);
  if (t === undefined) return busy();
  if (error) return fail(error, 409);
  if (!t) return fail('No tournament with that code.', 404);
  return json({ playerId, token });
}

function uniqueName(doc: Tournament, name: string, self: string) {
  const taken = new Set(doc.players.filter(p => p.id !== self).map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) { const n = name.slice(0, 15) + ' ' + i; if (!taken.has(n.toLowerCase())) return n; }
}

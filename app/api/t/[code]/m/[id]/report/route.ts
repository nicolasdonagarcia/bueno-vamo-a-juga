// Kick-off, every goal and the result of a match. From the match server (it proves itself
// with the secret both share, in the x-cc-server header), or for a peer-to-peer match from
// its host (the left-hand player's token). A match the host plays on their own device
// reports with the host's token in either case.
import { getStore } from '@/lib/store';
import { applyResult, getMatch, markLive, rulesFor, type Tournament } from '@/lib/tournament';
import { sameSecret } from '@/lib/ticket';
import { body, busy, fail, json, loadOr404, matchServer, playerByToken } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ code: string; id: string }> }) {
  const { code, id } = await ctx.params;
  const r = await loadOr404(code);
  if (r.error) return r.error;
  const b = await body(req);
  const m0 = getMatch(r.t, id);
  if (!m0) return fail('That match does not exist.', 404);
  const ms = matchServer();
  const fromServer = !!ms && sameSecret(req.headers.get('x-cc-server'), ms.secret);
  if (!fromServer) {
    const me = playerByToken(r.t, b.token);
    if (!me || me.id !== m0.a) return fail('Only the match host can report.', 403);
    // on the match server, the server reports; the host only for a match moved onto their device
    const onServer = rulesFor(r.t, m0.round, !!ms, m0).net === 'server';
    if (onServer && !b.local && m0.local !== 'host') return fail('The match server reports this match.', 403);
  } else if (typeof b.gen === 'number' && b.gen !== (m0.gen || 0)) {
    return fail('That match was reset since.', 409);
  }
  const sc = Array.isArray(b.score) ? [Math.max(0, Math.min(99, Number(b.score[0]) | 0)), Math.max(0, Math.min(99, Number(b.score[1]) | 0))] as [number, number] : null;
  let error = '';
  const t = await getStore().update(r.t.code, (doc: Tournament) => {
    const m = getMatch(doc, id);
    if (!m) return null;
    if (b.kind === 'start') {
      // local: the two players moved to the host's device after the online link failed
      if (m.status === 'live' && !(b.local && !m.local)) return null;
      return markLive(m, b.local ? 'host' : undefined, fromServer ? 'server' : b.local ? undefined : 'p2p', doc) ? doc : null;
    }
    if (b.kind === 'score') {
      if (!sc || !markLive(m, undefined, undefined, doc)) return null;
      m.score = sc;
      return doc;
    }
    if (b.kind === 'final') {
      if (!sc) { error = 'Missing score.'; return null; }
      if (m.status === 'done') return null;          // already in (a retry, or the organiser decided it)
      const side = sc[0] > sc[1] ? 'a' : sc[1] > sc[0] ? 'b' : null;
      if (!side || (b.winner && b.winner !== side)) { error = 'The score does not have a winner.'; return null; }
      const e = applyResult(doc, id, side, sc, 'played');
      if (e) { error = e; return null; }
      return doc;
    }
    return null;
  }).catch(() => undefined);
  if (t === undefined) return busy();
  if (error) return fail(error, 409);
  return json({ ok: true });
}

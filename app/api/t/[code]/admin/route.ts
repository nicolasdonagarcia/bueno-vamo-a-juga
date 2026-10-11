// Admin actions, authorised by the admin key from the creation link.
import { getStore } from '@/lib/store';
import { applyResult, buildBracket, cleanName, getMatch, markLive, resetMatch, type Tournament } from '@/lib/tournament';
import { body, fail, isAdmin, json, loadOr404 } from '@/lib/server';

export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  'no-match': 'That match does not exist.',
  'not-ready': 'That match does not have two players yet.',
  'already-done': 'That match is already finished.',
  'bad-winner': 'Pick a winner.',
  'next-started': 'The next match has already started, so this result can no longer change.'
};

function intIn(v: unknown, lo: number, hi: number, d: number) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const r = await loadOr404(code);
  if (r.error) return r.error;
  const b = await body(req);
  if (!isAdmin(r.t, b.key)) return fail('That admin key is not right.', 403);
  const action = String(b.action || '');
  if (action === 'check') return json({ ok: true });
  let error = '';
  const matchId = String(b.matchId || '');
  const t = await getStore().update(r.t.code, (doc: Tournament) => {
    switch (action) {
      case 'start':
        if (doc.status !== 'lobby') { error = 'The tournament has already started.'; return null; }
        if (doc.players.length < 2) { error = 'You need at least two players to start.'; return null; }
        buildBracket(doc);
        return doc;
      case 'restart':
        doc.status = 'lobby'; doc.matches = []; doc.rounds = 0; doc.champion = null; doc.startedAt = undefined; doc.finishedAt = undefined;
        return doc;
      case 'rules': {
        const x = (b.rules || {}) as Record<string, unknown>;
        doc.rules = {
          goals: intIn(x.goals, 1, 9, doc.rules.goals),
          capSec: intIn(x.capSec, 0, 900, doc.rules.capSec),
          finalGoals: intIn(x.finalGoals, 1, 9, doc.rules.finalGoals),
          finalCapSec: intIn(x.finalCapSec, 0, 900, doc.rules.finalCapSec),
          modifiers: x.modifiers === undefined ? doc.rules.modifiers : !!x.modifiers
        };
        return doc;
      }
      case 'rename':
        doc.name = cleanName(b.name) || doc.name;
        return doc;
      case 'remove':
        if (doc.status !== 'lobby') { error = 'Players can only be removed before the start.'; return null; }
        doc.players = doc.players.filter(p => p.id !== b.playerId);
        return doc;
      case 'result': {
        const side = b.winner === 'b' ? 'b' : b.winner === 'a' ? 'a' : null;
        if (!side) { error = 'Pick a winner.'; return null; }
        const sc = Array.isArray(b.score) ? [intIn(b.score[0], 0, 99, 0), intIn(b.score[1], 0, 99, 0)] as [number, number] : [0, 0] as [number, number];
        const via = b.via === 'local' ? 'local' : b.via === 'walkover' ? 'walkover' : 'admin';
        const e = applyResult(doc, matchId, side, sc, via, true);
        if (e) { error = MESSAGES[e]; return null; }
        return doc;
      }
      case 'reset': {
        const e = resetMatch(doc, matchId);
        if (e) { error = MESSAGES[e]; return null; }
        return doc;
      }
      // a match played on the admin's device ("Play here"): kick-off and live score
      case 'live': {
        const m = getMatch(doc, matchId);
        if (!m) { error = MESSAGES['no-match']; return null; }
        if (!m.a || !m.b) { error = MESSAGES['not-ready']; return null; }
        if (!markLive(m, 'admin')) { error = MESSAGES['already-done']; return null; }
        return doc;
      }
      case 'score': {
        const m = getMatch(doc, matchId);
        if (!m || m.status !== 'live' || !Array.isArray(b.score)) return null;
        m.score = [intIn(b.score[0], 0, 99, 0), intIn(b.score[1], 0, 99, 0)];
        m.updatedAt = Date.now();
        return doc;
      }
      default:
        error = 'Unknown action.';
        return null;
    }
  });
  if (error) return fail(error, 409);
  if (!t) return fail('No tournament with that code.', 404);
  return json({ ok: true });
}

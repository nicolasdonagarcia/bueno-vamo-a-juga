// A ticket to the match server for one match: the player's own seat (proved with their
// token), or the organiser watching (proved with the admin key). Only for the match on now.
import { currentMatch, getMatch, inputDelayOf, rulesFor } from '@/lib/tournament';
import { TICKET_MS, signTicket, type Ticket, type TicketPlayer } from '@/lib/ticket';
import { body, fail, isAdmin, json, loadOr404, matchServer, playerByToken } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ code: string; id: string }> }) {
  const ms = matchServer();
  if (!ms) return fail('This site has no match server, so matches run peer to peer.', 503);
  const { code, id } = await ctx.params;
  const r = await loadOr404(code);
  if (r.error) return r.error;
  const t = r.t;
  const m = getMatch(t, id);
  if (!m) return fail('That match does not exist.', 404);
  const b = await body(req);
  let seat: 0 | 1 | -1;
  if (b.key !== undefined) {
    if (!isAdmin(t, b.key)) return fail('Only the organiser can watch matches.', 403);
    seat = -1;
  } else {
    const me = playerByToken(t, b.token);
    if (!me || (me.id !== m.a && me.id !== m.b)) return fail('Not your match.', 403);
    seat = me.id === m.a ? 0 : 1;
  }
  if (m.status === 'done') return fail('This match is over.', 410);
  if (!m.a || !m.b || m.status === 'waiting') return fail('This match does not have two players yet.', 409);
  const rules = rulesFor(t, m.round, true, m);
  if (rules.net !== 'server') return fail('This match is played peer to peer.', 409);
  if (m.local) return fail('This match is being played on one device.', 409);
  const cur = currentMatch(t);
  if (seat >= 0 && (!cur || cur.id !== m.id)) return fail('Not your turn yet: another match is on.', 409);
  const pl = (pid: string): TicketPlayer => {
    const p = t.players.find(x => x.id === pid);
    return { id: pid, name: p ? p.name : '?', color: p ? p.color : 'orange', flag: p ? p.flag : '' };
  };
  const ticket: Ticket = {
    c: t.code, m: m.id, s: seat, x: Date.now() + TICKET_MS, g: m.gen || 0,
    a: pl(m.a), b: pl(m.b),
    r: { goals: rules.goals, capSec: rules.capSec, modifiers: rules.modifiers, inputDelay: inputDelayOf(t.rules) },
    sc: [m.score[0] | 0, m.score[1] | 0], st: m.status, lb: rules.label
  };
  return json({ ticket: signTicket(ticket, ms.secret), url: ms.url });
}

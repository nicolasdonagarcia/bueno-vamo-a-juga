// WebRTC signaling mailboxes for one match. The host (player A) and guest
// (player B) prove who they are with their tokens. Only the organiser can watch
// a match (the big screen's grid): a viewer's mailbox ("spec:<random>") needs
// the admin key, in the x-cc-admin header when polling and as `key` when posting.
import { getStore } from '@/lib/store';
import { getMatch } from '@/lib/tournament';
import { body, fail, isAdmin, json, loadOr404, playerByToken } from '@/lib/server';

export const dynamic = 'force-dynamic';
const SPEC = /^spec:[a-z0-9]{4,16}$/;

export async function GET(req: Request, ctx: { params: Promise<{ code: string; id: string }> }) {
  const { code, id } = await ctx.params;
  const r = await loadOr404(code);
  if (r.error) return r.error;
  const m = getMatch(r.t, id);
  if (!m) return fail('That match does not exist.', 404);
  const q = new URL(req.url).searchParams;
  const box = q.get('box') || '';
  const me = playerByToken(r.t, q.get('token'));
  const allowed = (box === 'host' && me && me.id === m.a) || (box === 'guest' && me && me.id === m.b) ||
    (SPEC.test(box) && isAdmin(r.t, req.headers.get('x-cc-admin')));
  if (!allowed) return fail(SPEC.test(box) ? 'Only the organiser can watch matches.' : 'Not your mailbox.', 403);
  const n = parseInt(q.get('after') || '-1', 10);
  const after = Number.isFinite(n) ? Math.max(-1, n) : -1;        // (0 is a real index: "after the first message")
  return json({ ...(await getStore().readSignals(r.t.code, id, box, after)), now: Date.now() });
}

export async function POST(req: Request, ctx: { params: Promise<{ code: string; id: string }> }) {
  const { code, id } = await ctx.params;
  const r = await loadOr404(code);
  if (r.error) return r.error;
  const m = getMatch(r.t, id);
  if (!m) return fail('That match does not exist.', 404);
  const b = await body(req);
  const from = String(b.from || ''), to = String(b.to || ''), type = String(b.type || '');
  const me = playerByToken(r.t, b.token);
  let ok = false;
  if (from === 'host') ok = !!me && me.id === m.a && (to === 'guest' || SPEC.test(to)) && (type === 'offer' || type === 'answer');
  else if (from === 'guest') ok = !!me && me.id === m.b && to === 'host' && (type === 'answer' || type === 'rejoin');
  else if (SPEC.test(from)) ok = to === 'host' && type === 'offer' && isAdmin(r.t, b.key);
  if (!ok) return fail(SPEC.test(from) ? 'Only the organiser can watch matches.' : 'Not allowed.', 403);
  const sdp = typeof b.sdp === 'string' ? b.sdp.slice(0, 20000) : undefined;
  const i = await getStore().pushSignal(r.t.code, id, to, {
    at: Date.now(), from, type, sdp,
    session: typeof b.session === 'string' ? b.session.slice(0, 24) : undefined,
    inst: typeof b.inst === 'string' ? b.inst.slice(0, 24) : undefined
  });
  return json({ i });
}

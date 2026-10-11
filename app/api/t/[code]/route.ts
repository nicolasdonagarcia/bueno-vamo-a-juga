// Public state of a tournament (polled by every page). Passing ?me=<token>
// marks that player as online for the admin and big-screen views.
import { getStore } from '@/lib/store';
import { publicView } from '@/lib/tournament';
import { json, loadOr404, playerByToken } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const r = await loadOr404(code);
  if (r.error) return r.error;
  const t = r.t;
  const q = new URL(req.url).searchParams;
  const me = playerByToken(t, q.get('me'));
  const store = getStore();
  const [, online] = await Promise.all([
    me && q.get('t') !== '0' ? store.touch(t.code, me.id) : Promise.resolve(),
    store.online(t.code, t.players.map(p => p.id))
  ]);
  if (me) online[me.id] = true;
  return json({ ...publicView(t), online, you: me ? me.id : null, now: Date.now() });
}

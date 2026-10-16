// The match server's reports to the app: kick-off, every goal and the result, for the
// bracket. One match's reports go one at a time and in order; a newer one replaces any
// still waiting (the latest score is all the bracket needs). They retry until the app
// answers, so a deploy that restarts the app in the middle of a match loses nothing.
export type ReportBody = { kind: 'start' | 'score' | 'final'; score?: [number, number]; winner?: 'a' | 'b' };
export type Reporter = (b: ReportBody) => void;

export function createReporter(o: { appUrl: string; secret: string; log: (s: string) => void }) {
  const base = o.appUrl.replace(/\/+$/, '');
  // code, match, gen: which match (gen: as the ticket had it, so a reset match ignores this room)
  // onFinal: whether the result got in (false with the app's reason when it said no)
  return function forMatch(code: string, match: string, gen: number, onFinal: (ok: boolean, msg: string) => void): Reporter {
    const url = base + '/api/t/' + encodeURIComponent(code) + '/m/' + encodeURIComponent(match) + '/report';
    let busy = false, next: ReportBody | null = null, finalSent = false;
    async function send(b: ReportBody): Promise<{ ok: boolean; msg: string }> {
      const until = Date.now() + (b.kind === 'final' ? 30 * 60000 : 2 * 60000);
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-server': o.secret },
            body: JSON.stringify({ ...b, gen }), signal: AbortSignal.timeout(8000)
          });
          if (r.ok) return { ok: true, msg: '' };
          if (r.status >= 400 && r.status < 500) {
            const j = await r.json().catch(() => ({})) as { error?: string };
            o.log('report ' + b.kind + ' ' + code + ' ' + match + ' refused: ' + r.status + ' ' + (j.error || ''));
            return { ok: false, msg: j.error || 'refused (' + r.status + ')' };
          }
          throw new Error('HTTP ' + r.status);
        } catch (e) {
          if (Date.now() > until) return { ok: false, msg: 'The app did not answer.' };
          if (attempt === 0 || attempt % 10 === 0) o.log('report ' + b.kind + ' ' + code + ' ' + match + ' failed (' + (e as Error).message + '), trying again');
          await new Promise(res => setTimeout(res, Math.min(15000, 400 * 2 ** Math.min(attempt, 6))));
        }
      }
    }
    async function pump() {
      busy = true;
      while (next) {
        const b = next;
        next = null;
        const res = await send(b);
        if (b.kind === 'final') onFinal(res.ok, res.msg);
      }
      busy = false;
    }
    return (b: ReportBody) => {
      if (finalSent) return;
      if (b.kind === 'final') finalSent = true;
      next = b;
      if (!busy) pump();
    };
  };
}

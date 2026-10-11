// ICE servers for WebRTC. With a Cloudflare TURN key configured, players whose
// network blocks direct connections are relayed; otherwise STUN only.
import { json } from '@/lib/server';

export const dynamic = 'force-dynamic';
type Ice = { urls: string | string[]; username?: string; credential?: string };
let cache: { at: number; servers: Ice[] } | null = null;
const STUN: Ice[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

export async function GET() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID, token = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !token) return json({ iceServers: STUN, relay: false });
  if (cache && Date.now() - cache.at < 3600_000) return json({ iceServers: cache.servers, relay: true });
  try {
    const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(keyId) + '/credentials/generate-ice-servers', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 4 * 3600 }),
      cache: 'no-store'
    });
    if (!r.ok) throw new Error('TURN ' + r.status);
    const j = await r.json() as { iceServers: Ice | Ice[] };
    const list = (Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers]).map(s => ({
      ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => !/:53(\?|$)/.test(u))
    }));
    cache = { at: Date.now(), servers: list };
    return json({ iceServers: list, relay: true });
  } catch {
    return json({ iceServers: STUN, relay: false });
  }
}

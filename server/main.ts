// THE COTERIE CUP: the match server
// Runs the physics of the live match 60 times a second and talks to the players and the
// viewers (the organiser's big screen, the live view) over one WebSocket each. Separate from
// the Next.js app on purpose: a deploy of the app, or a slow page render, never stalls a match.
//
//   node server/main.ts            (Node 22.18 or later runs the TypeScript as it is)
//
// environment
//   MATCH_SECRET   shared with the app: checks the tickets, signs the reports (required)
//   MATCH_PORT     port to listen on (3001)
//   MATCH_HOST     address to listen on (0.0.0.0; the droplet uses 127.0.0.1 behind Caddy)
//   APP_URL        where the app is, for the results (http://127.0.0.1:3000)
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyTicket } from '../lib/ticket.ts';
import { NET_VERSION, TICK } from '../lib/engine/shared.js';
import { createRoom, type Conn, type Room } from './room.ts';
import { createReporter } from './report.ts';

const SECRET = process.env.MATCH_SECRET || '';
const PORT = Number(process.env.MATCH_PORT || 3001);
const HOST = process.env.MATCH_HOST || '0.0.0.0';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000';
const MAX_ROOMS = 64;
const BACKED_UP = 256 * 1024;      // bytes waiting on a connection: skip pictures until it drains
// Pages ping once a second. A player silent for this long is gone (a network that drops out
// often leaves the connection looking open for minutes): close it, so the match pauses
// until they're back. A viewer's screen only matters to itself, so it gets longer.
const SILENT_PLAYER_MS = 3000, SILENT_VIEWER_MS = 10000;

function log(s: string) { console.log(new Date().toISOString().slice(11, 23) + ' ' + s); }
if (SECRET.length < 16) {
  console.error('MATCH_SECRET is missing or shorter than 16 characters. Set the same value for the app and the match server.');
  process.exit(1);
}

const reporter = createReporter({ appUrl: APP_URL, secret: SECRET, log });
const rooms = new Map<string, Room>();
const socks = new Map<WebSocket, Conn>();
const startedAt = Date.now();
let connSeq = 0, tickCost = 0;

/* ---------------- HTTP: health ----------------
   /health, asked from this machine (the deploy script), also lists the matches: names, scores.
   Anyone else, and /ws/health (the one that goes through Caddy, so anyone can open it), only
   learns that the server is up. */
function health(res: ServerResponse, full: boolean) {
  const body = JSON.stringify({
    ok: true, v: NET_VERSION, uptimeS: Math.round((Date.now() - startedAt) / 1000), rooms: rooms.size,
    tickMs: +tickCost.toFixed(3), memMB: Math.round(process.memoryUsage().rss / 1048576),
    ...(full ? { matches: Array.from(rooms.values()).map(r => r.info()) } : {})
  });
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(body);
}
const http = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (path === '/health' || path === '/ws/health')) {
    const here = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
    health(res, path === '/health' && here && !req.headers['x-forwarded-for']);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('The Coterie Cup match server. Matches connect over a WebSocket.\n');
});

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
http.on('upgrade', (req, socket, head) => {
  const path = (req.url || '/').split('?')[0];
  if (path !== '/ws' && path !== '/') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

function roomFor(t: NonNullable<ReturnType<typeof verifyTicket>>): Room | null {
  const key = t.c + ':' + t.m;
  let r = rooms.get(key);
  if (r && r.gen !== t.g) {                // the organiser reset the match: start again
    if (t.g < r.gen) return null;          // an old ticket
    log(key + ' reset by the organiser');
    r.close('reset');
    rooms.delete(key);
    r = undefined;
  }
  if (r) { r.update(t); return r; }
  if (rooms.size >= MAX_ROOMS) return null;
  r = createRoom(t, { log, reporter });
  rooms.set(key, r);
  return r;
}

wss.on('connection', (ws: WebSocket) => {
  const c: Conn = {
    id: ++connSeq, seat: -2, inst: '', room: null, pressTimes: [], lastSeen: Date.now(),
    sendText(s) { if (ws.readyState === 1) ws.send(s); },
    sendBin(buf) { if (ws.readyState === 1 && ws.bufferedAmount < BACKED_UP) ws.send(buf); },
    close(code, why) { try { ws.close(code || 1000, why || ''); } catch { /* gone already */ } }
  };
  socks.set(ws, c);
  let greeted = false;
  const helloTimer = setTimeout(() => { if (!greeted) c.close(4000, 'no hello'); }, 10000);
  const deny = (why: string) => { c.sendText(JSON.stringify({ k: 'denied', why })); setTimeout(() => c.close(4003, why), 50); };
  ws.on('message', (data, isBinary) => {
    c.lastSeen = Date.now();
    if (isBinary) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.k === 'ping') { c.sendText(JSON.stringify({ k: 'pong', t: msg.t })); return; }
    if (!greeted) {
      if (msg.k !== 'hello') return;
      if (msg.v !== NET_VERSION) { deny('version'); return; }
      const t = verifyTicket(msg.ticket, SECRET);
      if (!t) { deny('ticket'); return; }
      const room = roomFor(t);
      if (!room) { deny('busy'); return; }
      greeted = true;
      clearTimeout(helloTimer);
      room.join(c, t.s, typeof msg.inst === 'string' ? msg.inst.slice(0, 16) : '');
      return;
    }
    const room = c.room;
    if (!room) return;
    if (msg.k === 'press') room.press(c, msg);
    else if (msg.k === 'ready') room.ready(c);
    else if (msg.k === 'bye') { room.leave(c); c.close(1000, 'bye'); }
  });
  ws.on('close', () => { socks.delete(ws); clearTimeout(helloTimer); if (c.room) c.room.leave(c); });
  ws.on('error', () => { /* the close follows */ });
});

/* ---------------- the loop: 60 ticks a second, on real time, never ahead of it ---------------- */
const T0 = performance.now(), TICK_MS = TICK * 1000;
let ticks = 0;
function loop() {
  const now = performance.now();
  const due = Math.floor((now - T0) / TICK_MS);
  let n = 0;
  while (ticks < due && n < 4) {
    const t1 = performance.now();
    for (const r of rooms.values()) {
      try { r.tick(); } catch (e) { log(r.key + ' tick failed: ' + ((e as Error).stack || e)); }
    }
    tickCost = tickCost * 0.98 + (performance.now() - t1) * 0.02;
    ticks++; n++;
  }
  if (due - ticks > 30) ticks = due;      // the machine stalled for half a second: skip ahead rather than rush
  setTimeout(loop, Math.max(0, T0 + (ticks + 1) * TICK_MS - performance.now()));
}
loop();

// connections that went silent
setInterval(() => {
  const now = Date.now();
  for (const [ws, c] of socks) {
    if (c.seat === -2) continue;                    // not in yet: the hello timer sees to it
    if (now - c.lastSeen > (c.seat >= 0 ? SILENT_PLAYER_MS : SILENT_VIEWER_MS)) {
      log((c.room ? c.room.key + ' ' : '') + (c.seat >= 0 ? 'player ' + c.seat : 'viewer') + ' silent for ' + (now - c.lastSeen) + ' ms: closing');
      socks.delete(ws);
      ws.terminate();
    }
  }
}, 500).unref();

// rooms nobody needs any more
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of rooms) if (r.idle(now)) { rooms.delete(k); log(k + ' closed'); }
}, 5000).unref();

http.listen(PORT, HOST, () => log('match server on ' + HOST + ':' + PORT + ', reporting to ' + APP_URL));

// a deploy restarts us: tell the pages, so they come back to the new server by themselves
function shutdown(sig: string) {
  log(sig + ': closing');
  for (const r of rooms.values()) r.close('restart');
  http.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

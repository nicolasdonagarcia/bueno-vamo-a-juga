/* The link to the match server for one match: one WebSocket.
   The page proves who it is with a ticket from the app (signed, short-lived): a
   player's for their seat, the organiser's for watching. A dropped connection
   comes back on its own, with a fresh ticket each time (the server may have
   restarted in between, or the organiser may have decided the match).

   messages (JSON, both ways): hello, welcome, denied, ready, lobby, start, resume,
   resumed, press, pa (press answer), op (the other player's press), ev (match
   events), sync, ping, pong, result, bye. Binary: full states to players, snapshot
   frames to the organiser's screen.                                             */
import { NET_VERSION } from '../engine/shared.js';

function rid() { return Math.random().toString(36).slice(2, 10); }
// No answer to a ping for this long: the connection is gone, even if the browser hasn't
// noticed (a network that drops out often leaves a WebSocket looking open for minutes).
// The match server gives up on a silent player a little sooner and pauses the match.
const DEAD_MS = 3500;

export function createServerLink(o) {
  // o: { getTicket: async () => ({ ticket, url }), handlers, fakeLag }
  //    getTicket throws an error with .fatal = true when trying again is pointless
  const h = o.handlers || {};
  const inst = rid();                // this page load: the server tells a reload from a reconnect
  let ws = null, closed = false, open = false, attempt = 0, retryTimer = 0, pingTimer = 0;
  let rtt = null, lastPongAt = 0, pingOut = 0;     // pingOut: when the oldest unanswered ping went out
  let stallUntil = 0;                // tests: silent until then, as if the network had gone
  const stalled = () => performance.now() < stallUntil;
  const rtts = [];                   // recent round trips, for the jitter
  const log = (...a) => { if (h.log) h.log(a.join(' ')); };

  // tests only (o.fakeLag = { ms, jitter }): hold back what this page sends and receives, like a
  // long way to the server. A WebSocket keeps its order, so both directions stay in order.
  const lag = o.fakeLag && o.fakeLag.ms > 0 ? o.fakeLag : null;
  const inAt = { t: 0 }, outAt = { t: 0 };
  function later(fn, q) {
    if (!lag) { fn(); return; }
    const now = performance.now();
    const at = Math.max(now + lag.ms + Math.random() * (lag.jitter || 0), q.t);
    q.t = at;
    setTimeout(fn, at - now);
  }

  async function connect() {
    if (closed) return;
    clearTimeout(retryTimer);
    if (stalled()) { retryTimer = setTimeout(connect, stallUntil - performance.now() + 50); return; }
    let t;
    try { t = await o.getTicket(); }
    catch (e) {
      if (closed) return;
      if (e && e.fatal) { log('no ticket:', e.message); if (h.onDenied) h.onDenied(e.message || 'denied'); return; }
      log('ticket failed:', e && e.message);
      retry();
      return;
    }
    if (closed) return;
    let sock;
    try { sock = new WebSocket(t.url); } catch (e) { log('bad url', t.url); retry(); return; }
    ws = sock;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => { if (ws === sock) rawSend(sock, JSON.stringify({ k: 'hello', v: NET_VERSION, ticket: t.ticket, inst })); };
    sock.onmessage = e => later(() => { if (ws === sock && !stalled()) onMessage(e.data); }, inAt);
    sock.onclose = () => later(() => { if (ws === sock && !stalled()) lost('closed'); }, inAt);
    // a connection that never opens: browsers follow the error with a close, Node doesn't
    sock.onerror = () => later(() => { if (ws === sock && !open && !stalled()) lost('could not connect'); }, inAt);
    setTimeout(() => { if (ws === sock && !open && !stalled()) lost('no answer from the match server'); }, 8000);
  }
  // the connection is gone: say so, and come back with a fresh ticket
  function lost(why) {
    const s = ws;
    if (!s) return;
    ws = null;
    if (s.readyState <= 1) { try { s.close(); } catch (e) { } }
    const was = open;
    open = false; pingOut = 0;
    clearInterval(pingTimer);
    log(why);
    if (was && h.onClose) h.onClose();
    retry();
  }
  function retry() {
    if (closed) return;
    attempt++;
    const ms = Math.min(3000, 400 * attempt) + Math.random() * 300;
    retryTimer = setTimeout(connect, ms);
  }
  function rawSend(sock, data) {
    if (stalled()) return;
    later(() => { if (sock.readyState === 1) { try { sock.send(data); } catch (e) { } } }, outAt);
  }
  function onMessage(data) {
    if (typeof data !== 'string') { if (open && h.onState) h.onState(data); return; }
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    switch (msg.k) {
      case 'welcome':
        open = true; attempt = 0; pingOut = 0;
        clearInterval(pingTimer);
        ping();
        pingTimer = setInterval(ping, 1000);
        log('open as seat', msg.seat);
        if (h.onOpen) h.onOpen(msg);
        return;
      case 'denied':
        log('denied:', msg.why);
        closed = true;
        if (ws) { try { ws.close(); } catch (e) { } }
        if (h.onDenied) h.onDenied(msg.why || 'denied', msg);
        return;
      case 'pong': {
        const sample = performance.now() - msg.t;
        if (!(sample >= 0 && sample < 10000)) return;
        lastPongAt = performance.now();
        pingOut = 0;
        rtts.push(sample); if (rtts.length > 30) rtts.shift();
        rtt = rtt == null ? sample : rtt * 0.8 + sample * 0.2;
        if (h.onRtt) h.onRtt(rtt);
        return;
      }
    }
    if (h.onCtl) h.onCtl(msg);
  }
  function ping() {
    const now = performance.now();
    if (open && pingOut && now - pingOut > DEAD_MS) { lost('no answer for ' + Math.round(now - pingOut) + ' ms'); return; }
    if (!pingOut) pingOut = now;
    send({ k: 'ping', t: now });
  }
  function send(msg) { if (ws && ws.readyState === 1) rawSend(ws, JSON.stringify(msg)); }

  connect();

  return {
    get rtt() { return rtt; },
    // how much the round trip wobbles: the average gap between one ping's trip and the next
    get jitter() {
      if (rtts.length < 3) return null;
      let s = 0;
      for (let i = 1; i < rtts.length; i++) s += Math.abs(rtts[i] - rtts[i - 1]);
      return s / (rtts.length - 1);
    },
    get lastPongAge() { return lastPongAt ? performance.now() - lastPongAt : Infinity; },
    isOpen() { return open; },
    send,
    // tests: drop the connection now (it comes back by itself)
    drop() { if (ws) { try { ws.close(); } catch (e) { } } },
    // tests: go silent both ways for ms, like a network that drops out without closing anything
    stall(ms) { stallUntil = performance.now() + ms; },
    close() {
      closed = true;
      clearTimeout(retryTimer); clearInterval(pingTimer);
      if (ws) { const s = ws; ws = null; try { if (s.readyState === 1) s.send(JSON.stringify({ k: 'bye' })); s.close(); } catch (e) { } }
    }
  };
}

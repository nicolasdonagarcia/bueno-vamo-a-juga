/* Peer-to-peer link for one match (WebRTC data channels).
   The host runs the physics and connects to the guest and to up to four viewers
   (the organiser's big screen; watching needs the admin key).
   Signaling (offer/answer) goes through the app's API: each side posts to the
   other's mailbox and polls its own. ICE is gathered in full before sending,
   so a connection needs exactly two signaling messages.

   channels:  "st"  unordered, no retransmits: snapshots (binary)
              "ctl" reliable, ordered: events, presses, ready, ping (JSON)   */

const GATHER_MS = 2500, GATHER_TURN_MS = 5000, CONNECT_MS = 14000;

function rid() { return Math.random().toString(36).slice(2, 10); }

// Wait for the network candidates to put in the offer/answer. With a relay
// configured, a relay candidate is the one that matters on locked-down networks
// (UDP blocked, TURN over TLS on 443 is slower to arrive), so wait for one.
async function gathered(pc, withTurn) {
  if (pc.iceGatheringState === 'complete') return;
  const t0 = performance.now();
  await new Promise(res => {
    let relay = false;
    const limit = setTimeout(done, withTurn ? GATHER_TURN_MS : GATHER_MS);
    const tick = setInterval(() => { if (relay && performance.now() - t0 > 1200) done(); }, 100);
    function done() {
      clearTimeout(limit); clearInterval(tick);
      pc.removeEventListener('icegatheringstatechange', chk); pc.removeEventListener('icecandidate', cand);
      res();
    }
    function chk() { if (pc.iceGatheringState === 'complete') done(); }
    function cand(e) { if (e.candidate && / typ relay /.test(e.candidate.candidate)) relay = true; }
    pc.addEventListener('icegatheringstatechange', chk);
    pc.addEventListener('icecandidate', cand);
  });
}

export async function routeOf(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
    if (!pair) stats.forEach(s => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = pair || s; });
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
    const relay = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
    return { relay, rtt: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null };
  } catch (e) { return null; }
}

export function createLink(o) {
  // o: { code, matchId, role: 'host'|'guest'|'spectator', token, adminKey, iceServers, handlers }
  //    only the organiser watches: a spectator link needs the admin key
  const base = '/api/t/' + encodeURIComponent(o.code) + '/m/' + encodeURIComponent(o.matchId) + '/signal';
  const h = o.handlers || {};
  const role = o.role;
  const specId = role === 'spectator' ? 'spec:' + rid() : null;
  const box = role === 'host' ? 'host' : role === 'guest' ? 'guest' : specId;
  let closed = false, after = -1, pollTimer = 0, firstPoll = true, guestSeenAt = 0, rejoinTimer = 0;
  let waitSince = performance.now();   // since when we have been without the other side (polls slow down after a while)
  const inst = rid();            // this page load; a reload is a new guest to the host
  const withTurn = (o.iceServers || []).some(s => [].concat(s.urls || []).some(u => /^turns?:/.test(u)));
  const peers = new Map();       // key 'guest' | 'spec:xxx' -> peer
  let rtt = null;

  const log = (...a) => { if (h.log) h.log(a.join(' ')); };

  // true once the server has the message
  async function post(msg) {
    try {
      const who = role === 'spectator' ? { from: specId, key: o.adminKey } : { token: o.token, from: role };
      const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign(who, msg)) });
      if (r.status === 403 && role === 'spectator') denied();
      return r.ok;
    } catch (e) { log('signal post failed', e && e.message); return false; }
  }
  function denied() {
    if (closed) return;
    log('not allowed to watch');
    closed = true;
    clearTimeout(pollTimer);
    for (const p of Array.from(peers.values())) p.close(true);
    if (h.onDenied) h.onDenied();
  }
  let polling = false;
  async function poll() {
    if (closed) return;
    polling = true;
    try {
      const r = await fetch(base + '?box=' + encodeURIComponent(box) + '&after=' + after + (o.token ? '&token=' + encodeURIComponent(o.token) : ''),
        { cache: 'no-store', headers: role === 'spectator' && o.adminKey ? { 'x-cc-admin': o.adminKey } : undefined });
      if (r.status === 403 && role === 'spectator') { polling = false; denied(); return; }
      if (r.ok) {
        const j = await r.json();
        let msgs = j.msgs || [];
        if (msgs.length) after = Math.max(after, msgs[msgs.length - 1].i);
        if (firstPoll && role === 'host') {
          // old history: the opening offer covers a waiting guest. A viewer's offer from the last
          // few seconds is still waiting for an answer, so the big screen connects straight away.
          const fresh = new Map();
          for (const m of msgs) if (m.type === 'offer' && String(m.from).startsWith('spec:') && j.now && j.now - m.at < 11000) fresh.set(m.from, m);
          msgs = Array.from(fresh.values());
        }
        if (role === 'guest') { const offers = msgs.filter(m => m.type === 'offer'); msgs = offers.length ? [offers[offers.length - 1]] : []; }
        firstPoll = false;
        for (const m of msgs) await onSignal(m);
      }
    } catch (e) { /* offline for a moment: try again */ }
    polling = false;
    if (!closed) pollTimer = setTimeout(poll, pollDelay());
  }
  // look at the mailbox soon (an offer just went out), unless a look is already under way
  function kick() { if (closed || polling) return; clearTimeout(pollTimer); pollTimer = setTimeout(poll, 300); }
  function pollDelay() {
    const p = peers.get(role === 'host' ? 'guest' : 'host');
    // the host still listens for viewers; a connected viewer has nothing to wait for
    if (p && p.open) return role === 'host' ? 1500 : role === 'guest' ? 2500 : 10000;
    const waited = performance.now() - waitSince;
    if (role === 'host') return waited < 30000 ? 700 : 1500;
    return waited < 20000 ? 450 : 1500;
  }

  function newPeer(key, session, offerer) {
    const old = peers.get(key);
    if (old) old.close(true);
    const pc = new RTCPeerConnection({ iceServers: o.iceServers || [] });
    const peer = { key, session, pc, st: null, ctl: null, open: false, timer: 0, failTimer: 0, route: null,
      close(silent) {
        clearTimeout(peer.timer); clearTimeout(peer.failTimer);
        try { pc.close(); } catch (e) { }
        const was = peer.open;
        peer.open = false;
        if (peers.get(key) === peer) peers.delete(key);
        if (was && !silent && h.onClose) h.onClose(key);
      }
    };
    const wire = (ch) => {
      ch.binaryType = 'arraybuffer';
      if (ch.label === 'st') { peer.st = ch; ch.onmessage = e => { if (h.onState) h.onState(e.data, key); }; }
      else {
        peer.ctl = ch;
        ch.onmessage = e => { let msg; try { msg = JSON.parse(e.data); } catch (x) { return; } onCtl(msg, peer); };
        ch.onopen = () => {
          log('open', key, peer.session);
          peer.open = true; clearTimeout(peer.timer);
          routeOf(pc).then(r => { peer.route = r; if (h.onRoute) h.onRoute(key, r); });
          if (h.onOpen) h.onOpen(key);
        };
        // the channel closing means this connection is over: start again straight away
        // (the host offers anew, the guest asks for an offer, a viewer reconnects)
        ch.onclose = () => { if (peer.open) lost(peer); };
      }
    };
    if (offerer) {
      wire(pc.createDataChannel('st', { ordered: false, maxRetransmits: 0 }));
      wire(pc.createDataChannel('ctl', { ordered: true }));
    } else pc.ondatachannel = e => wire(e.channel);
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'disconnected') { clearTimeout(peer.failTimer); peer.failTimer = setTimeout(() => lost(peer), 4000); }
      else if (s === 'failed' || s === 'closed') lost(peer);
      else if (s === 'connected' || s === 'completed') clearTimeout(peer.failTimer);
    };
    peers.set(key, peer);
    return peer;
  }
  function lost(peer) {
    if (closed || peers.get(peer.key) !== peer) return;
    log('lost', peer.key);
    waitSince = performance.now();
    peer.close(false);
    if (role === 'host' && peer.key === 'guest') offerGuest();
    if (role === 'guest') { clearTimeout(rejoinTimer); rejoin(); }      // ask the host for a new offer now, not in 10 s
    if (role === 'spectator') setTimeout(() => !closed && watch(), 1500);
  }

  /* ---------------- host ---------------- */
  async function offerGuest() {
    if (closed) return;
    const peer = newPeer('guest', rid(), true);
    peer.offeredAt = performance.now();
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      await gathered(peer.pc, withTurn);
      if (closed || peers.get('guest') !== peer) return;
      peer.posted = await post({ to: 'guest', type: 'offer', session: peer.session, sdp: peer.pc.localDescription.sdp });
      log('offered guest', peer.session, peer.posted ? '' : '(not delivered)');
    } catch (e) { log('offer failed', e && e.message); }
    // re-offer on timeout only while a guest page is actually around
    peer.timer = setTimeout(() => {
      if (!peer.open && peers.get('guest') === peer && performance.now() - guestSeenAt < 60000) { log('guest timeout'); offerGuest(); }
    }, CONNECT_MS);
  }
  async function answerSpectator(m) {
    const peer = newPeer(m.from, m.session, false);
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      await gathered(peer.pc, withTurn);
      await post({ to: m.from, type: 'answer', session: m.session, sdp: peer.pc.localDescription.sdp });
    } catch (e) { log('spectator answer failed', e && e.message); peer.close(true); }
  }

  /* ---------------- guest ---------------- */
  async function answerHost(m) {
    const cur = peers.get('host');
    if (cur && cur.session === m.session) return;
    const peer = newPeer('host', m.session, false);
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      await gathered(peer.pc, withTurn);
      await post({ to: 'host', type: 'answer', session: m.session, inst, sdp: peer.pc.localDescription.sdp });
      log('answered host', m.session);
    } catch (e) { log('answer failed', e && e.message); peer.close(true); }
  }

  /* ---------------- spectator ---------------- */
  async function watch() {
    if (closed) return;
    const peer = newPeer('host', rid(), true);
    waitSince = performance.now();
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      await gathered(peer.pc, withTurn);
      if (closed || peers.get('host') !== peer) return;
      await post({ to: 'host', type: 'offer', session: peer.session, sdp: peer.pc.localDescription.sdp });
      kick();
    } catch (e) { log('watch failed', e && e.message); }
    peer.timer = setTimeout(() => { if (!closed && !peer.open && peers.get('host') === peer) watch(); }, CONNECT_MS);
  }

  async function onSignal(m) {
    if (role === 'host') {
      if (m.from === 'guest') guestSeenAt = performance.now();
      if (m.type === 'answer' && m.from === 'guest') {
        const p = peers.get('guest');
        if (p && p.session === m.session && !p.pc.currentRemoteDescription) {
          p.guestInst = m.inst;
          try { await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); } catch (e) { log('bad answer', e && e.message); }
        }
      } else if (m.type === 'rejoin' && m.from === 'guest') {
        const p = peers.get('guest');
        log('rejoin from', m.inst, p ? (p.open ? 'open' : 'pending') + ' ' + (p.guestInst || '-') + ' posted ' + p.posted : 'no peer');
        if (p && p.open && p.guestInst === m.inst) return;                          // still connected to that page
        if (p && !p.open && p.posted !== false && performance.now() - p.offeredAt < CONNECT_MS) return;   // an offer is still being worked out
        offerGuest();
      } else if (m.type === 'offer' && String(m.from).startsWith('spec:')) {
        if (Array.from(peers.keys()).filter(k => k.startsWith('spec:')).length < 4) answerSpectator(m);
      }
    } else if (role === 'guest') {
      if (m.type === 'offer') answerHost(m);
    } else if (m.type === 'answer') {
      const p = peers.get('host');
      if (p && p.session === m.session && !p.pc.currentRemoteDescription) {
        try { await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); } catch (e) { log('bad answer', e && e.message); }
      }
    }
  }

  function onCtl(msg, peer) {
    if (msg.k === 'ping') { sendTo(peer, { k: 'pong', t: msg.t }); return; }
    if (msg.k === 'pong') {
      const sample = performance.now() - msg.t;
      rtt = rtt == null ? sample : rtt * 0.8 + sample * 0.2;
      if (peer.key === 'guest') sendTo(peer, { k: 'rtt', rtt });
      if (h.onRtt) h.onRtt(rtt, peer.key);
      return;
    }
    if (msg.k === 'rtt') { rtt = msg.rtt; if (h.onRtt) h.onRtt(rtt, peer.key); return; }
    if (h.onCtl) h.onCtl(msg, peer.key);
  }
  function sendTo(peer, msg) {
    if (peer && peer.ctl && peer.ctl.readyState === 'open') { try { peer.ctl.send(JSON.stringify(msg)); } catch (e) { } }
  }
  const pingTimer = setInterval(() => {
    if (role !== 'host') return;
    const g = peers.get('guest');
    if (g && g.open) sendTo(g, { k: 'ping', t: performance.now() });
  }, 1000);

  // start
  function rejoin() {
    if (closed) return;
    const p = peers.get('host');
    if (!p || !p.open) post({ to: 'host', type: 'rejoin', inst });
    rejoinTimer = setTimeout(rejoin, 10000);
  }
  if (role === 'host') offerGuest();
  else if (role === 'guest') rejoin();
  else watch();
  poll();

  return {
    get rtt() { return rtt; },
    route(key) { const p = peers.get(key); return p ? p.route : null; },
    isOpen(key) { const p = peers.get(key || (role === 'host' ? 'guest' : 'host')); return !!(p && p.open); },
    keys() { return Array.from(peers.keys()); },
    // host: one snapshot to everybody connected
    sendState(buf) {
      for (const p of peers.values()) {
        if (p.st && p.st.readyState === 'open' && p.st.bufferedAmount < 65536) { try { p.st.send(buf); } catch (e) { } }
      }
    },
    send(msg, key) {
      if (key) { sendTo(peers.get(key), msg); return; }
      for (const p of peers.values()) sendTo(p, msg);
    },
    restart() { if (role === 'host') offerGuest(); else if (role === 'guest') post({ to: 'host', type: 'rejoin', inst: rid() }); else watch(); },
    close() {
      closed = true;
      clearTimeout(pollTimer); clearInterval(pingTimer); clearTimeout(rejoinTimer);
      for (const p of Array.from(peers.values())) { sendTo(p, { k: 'bye' }); p.close(true); }
      peers.clear();
    }
  };
}

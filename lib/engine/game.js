/* ------------------------------------------------------------------
   THE COTERIE CUP: the match on a page
   Drawing, sound, input and the HUD; the physics and rules are in sim.js and a
   player's prediction in predict.js (both run in Node too). createGame(root, opts)
   builds a pitch inside `root`.

   modes
     practice   you (left) against the CPU, simulated here
     local2p    two people on one keyboard, simulated here
     demo       CPU against CPU, for backgrounds
     player     on the match server: this player's team is opts.team. The page runs
                its own copy of the match a little ahead of the server (prediction),
                so its presses show at once; the server's full state, 20 times a
                second, puts the copy right again.
     host       peer to peer: simulated here (the left team), the guest's presses
                arrive over the network
     guest      peer to peer: the right team. Predicts like a player; without
                prediction (opts.predict false) it draws the host's snapshots and the
                host waits as long, so both react equally late.
     spectator  draws snapshots (from the match server or a peer-to-peer host)
   ------------------------------------------------------------------ */
import {
  TAU, WH, WW, GROUND_Y, GOAL_D, BAR_T, TICK,
  HEAD_R, TORSO_W, TORSO_H, ARM_W, ARM_H, THIGH_H, SHIN_W, SHIN_H, FOOT_W, FOOT_H, THIGH_W,
  BALL_TYPES, ballReach, clamp, angDiff, makeRng, readable, resolveKits, encodeFrame, decodeFrame, FX
} from './shared.js';
import { Snd } from './sound.js';
import { createSim, FULL_VERSION, teamOfSlot, isKeeper, palette, barUnderFor, nearestBallOf, SKINS, HAIRS } from './sim.js';
import { createPredictor } from './predict.js';

const OUT_TEXT = {
  roof: 'The ball was stuck on the goal roof',
  dead: 'The ball stopped dead',
  lost: 'The ball left the pitch'
};
const OUTLINE = '#0b0e26', LW = 2.4;
const FULL_EVERY = 3;               // host: the full state every 3 ticks (20 a second) to the guest

function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
// the page's own body font (next/font gives it a generated name), for text drawn on the canvas
let fontBody = '';
function bodyFont() {
  if (fontBody) return fontBody;
  let fam = '';
  try { fam = getComputedStyle(document.documentElement).getPropertyValue('--font-body').trim(); } catch (e) { }
  fontBody = (fam ? fam + ', ' : '') + 'Nunito, "Segoe UI", system-ui, sans-serif';
  return fontBody;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

const TEMPLATE = `
<div class="wc-stage" data-el="stage">
  <div class="wc-frame" data-el="frame">
    <canvas class="wc-pitch" data-el="pitch" aria-label="The pitch"></canvas>
    <div class="wc-hud" data-el="hud">
      <div class="wc-board">
        <span class="wc-side a"><i data-el="dotA"></i><span class="wc-flag" data-el="flagA"></span><b data-el="nameA"></b></span>
        <span class="wc-score"><b data-el="sa">0</b><span class="wc-dash">:</span><b data-el="sb">0</b></span>
        <span class="wc-side b"><b data-el="nameB"></b><span class="wc-flag" data-el="flagB"></span><i data-el="dotB"></i></span>
      </div>
      <div class="wc-sub"><span class="wc-clock" data-el="clock" hidden></span><span class="wc-mods" data-el="mods"></span></div>
    </div>
    <button class="wc-icon wc-mute" data-el="mute" type="button" aria-label="Sound on" aria-pressed="false">
      <svg class="on" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <svg class="off" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>
    <p class="wc-hint" data-el="hint" hidden></p>
    <div class="wc-toast" data-el="toast" hidden role="status" aria-live="polite"><b data-el="toastT"></b><span data-el="toastS"></span></div>
    <div class="wc-banner" data-el="banner" hidden aria-live="assertive"><b data-el="bannerT"></b><span data-el="bannerS"></span></div>
    <div class="wc-overlay" data-el="overlay"></div>
  </div>
  <div class="wc-pads" data-el="pads" hidden>
    <button class="wc-pad" data-el="padA" type="button" aria-label="Jump and kick">Kick</button>
    <button class="wc-pad b" data-el="padB" type="button" aria-label="Right team: jump and kick">Kick</button>
  </div>
</div>`;

export function createGame(root, opts) {
  opts = opts || {};
  const mode = opts.mode || 'practice';
  const NET = mode === 'host' || mode === 'guest' || mode === 'player' || mode === 'spectator';
  const SIM = mode === 'practice' || mode === 'local2p' || mode === 'demo' || mode === 'host';
  const DIRECT = SIM && !NET;                  // draw straight from the physics bodies
  const PRED = mode === 'player' || (mode === 'guest' && opts.predict !== false);   // runs its own copy ahead of the authority
  const hooks = opts.hooks || {};
  const localTeam = mode === 'guest' ? 1 : mode === 'player' ? (opts.team === 1 ? 1 : 0) : (mode === 'spectator' || mode === 'demo') ? -1 : 0;
  let renderEvery = Math.max(1, opts.renderEvery || 1);
  const snapEvery = Math.max(1, opts.snapEvery || 1);      // host: a snapshot every tick (60 a second), so viewers need less of a buffer
  let players = normPlayers(opts.players);
  let rules = Object.assign({ goals: 5, capSec: 0, modifiers: true }, opts.rules || {});
  let botSkill = opts.bot ? (opts.bot.skill || 0.7) : 0;
  let inputDelay = clamp(Math.round(opts.inputDelay || 0), 0, 8);   // ticks a press waits (a cup setting, the same on every screen)
  let kits = resolveKits(players[0].color, players[1].color);
  const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let destroyed = false, paused = false, inputOn = opts.input !== false;
  // this pitch's sounds; a page with more than one pitch keeps all but one quiet (setSound)
  let soundOn = !(mode === 'demo' && !opts.demoSound) && opts.sound !== false;
  const quiet = () => { };
  const snd = new Proxy(Snd, { get: (t, k) => { const v = t[k]; return typeof v === 'function' ? (soundOn ? v.bind(t) : quiet) : v; } });

  function normPlayers(p) {
    const d = [{ name: 'Orange', color: 'orange', flag: null }, { name: 'Teal', color: 'teal', flag: null }];
    p = p || d;
    return [0, 1].map(i => ({ name: (p[i] && p[i].name) || d[i].name, color: (p[i] && p[i].color) || d[i].color, flag: (p[i] && p[i].flag) || null }));
  }

  /* ============================ DOM ============================ */
  root.innerHTML = TEMPLATE;
  const el = {};
  root.querySelectorAll('[data-el]').forEach(n => { el[n.getAttribute('data-el')] = n; });
  const canvas = el.pitch, ctx = canvas.getContext('2d');
  const touchUI = typeof matchMedia !== 'undefined' && matchMedia('(hover: none) and (pointer: coarse)').matches;
  function vrand(a, b) { return a + Math.random() * (b - a); }

  /* ============================ the simulation ============================ */
  // practice, one device, the demo and a peer-to-peer host run the match here
  let tickFx = [], netFx = [], tickN = 0;
  const sim = SIM ? createSim({
    mode, rules, players, seed: opts.seed, forceRound: opts.forceRound,
    cpuSkill: opts.cpuSkill != null ? opts.cpuSkill : 0.74,
    botSkill: mode === 'practice' || mode === 'host' ? botSkill : 0,
    authority: mode === 'host', reduceMotion,
    onEvent: ev => emitEvent(ev),
    onFx: (type, x, y, v) => emitFx(type, x, y, v),
    onScore: (sc, info) => { if (hooks.onScore) hooks.onScore(sc, info); },
    onEnd: e => { if (hooks.onEnd) hooks.onEnd(e); },
    // host: the guest's copy hears about the host's own presses at once (tick and lean)
    onPress: (slot, n, lean, rnd) => { if (mode === 'host' && teamOfSlot(slot) === 0 && hooks.onHostPress) hooks.onHostPress(slot, n, lean, rnd); }
  }) : null;

  /* ============================ prediction ============================ */
  // a player on the match server, or a peer-to-peer guest: its own copy, a little ahead
  const pred = PRED ? createPredictor({
    team: localTeam, inputDelay, players, bot: botSkill,
    onFx: e => playFx(e),
    hasRound: r => puppetSets.has(r),
    // sent as soon as it is made: { seq, n (tick), slots, leans, v (the tick it was looking at) }
    onPress: p => { if (hooks.onPress) hooks.onPress(p.slots, renderT, p.n, p.seq, p.leans, p.v); }
  }) : null;

  function emitFx(type, x, y, v) {
    if (mode === 'demo' && !opts.demoSound) { if (type === FX.LAND) dust(x, y, 4); return; }
    if (DIRECT) playFx({ type, x, y, v });
    else tickFx.push({ type, x, y, v });
  }
  function emitEvent(ev) {
    if (DIRECT) { applyEvent(ev); return; }
    queueEvent(ev);
    if (hooks.onEvent) hooks.onEvent(ev);
  }
  // one tick of the match here; a peer-to-peer host also records the frame for its own
  // picture and streams snapshots (and the guest's full state)
  function simTick() {
    sim.tick(TICK);
    if (mode === 'host') {
      const f = sim.captureFrame(tickFx);
      pushFrame(f);
      for (const e of tickFx) netFx.push(e);
      if (++tickN % snapEvery === 0 && hooks.onSnapshot) {
        hooks.onSnapshot(encodeFrame(Object.assign({}, f, { fx: netFx })));
        netFx = [];
      }
      if (tickN % FULL_EVERY === 0 && hooks.onFullState) hooks.onFullState(sim.captureState());
    }
    tickFx = [];
  }
  // Peer to peer without prediction ("Equal delay"), the picture is a moment behind the
  // simulation (the guest's by the trip and the buffer, the host's on purpose so both wait the
  // same) and the men keep swaying meanwhile: a press timed at the peak of the lean would land
  // on the way back. So such a press jumps with the lean the man had in the picture the player
  // was looking at (vt, host clock), from the host's own record of frames, as long as he is
  // still on his feet.
  let lastRewind = null;
  function leanSeen(c, vt) {
    const hostClock = sim.hostClock, round = sim.round;
    if (!c || vt == null || !isFinite(vt) || vt > hostClock || hostClock - vt > 0.6) return null;
    let a = null, b = null;
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i].t <= vt) { a = frames[i]; b = frames[i + 1] || null; break; }
    if (!a || a.round !== round) return null;
    const angle = f => { const mm = f && f.round === round ? f.men.find(x => x.slot === c.slot) : null; return mm ? mm.p[2] : null; };
    let ang = angle(a);
    if (ang == null) return null;
    const bAng = angle(b);
    if (bAng != null && b.t > a.t) ang += angDiff(bAng, ang) * clamp((vt - a.t) / (b.t - a.t), 0, 1);
    const seen = angDiff(ang, 0), now = angDiff(c.torso.getAngle(), 0);
    if (Math.abs(seen) > 1.1 || Math.abs(now) > 1.1 || Math.abs(seen - now) > 0.9) return null;   // fell over meanwhile
    lastRewind = { seen: +seen.toFixed(3), now: +now.toFixed(3), ms: Math.round((hostClock - vt) * 1000) };
    return seen;
  }

  /* ============================ frames, timeline ============================ */
  // A frame is one moment of the match: every body's position and angle, the
  // score and clock, plus the cosmetic effects that happened during it.
  let frames = [];                 // ascending t
  let evq = [];                    // pending display events, ascending t
  const puppetSets = new Map();    // round -> puppets built from that round's description
  let view = null;                 // what is being drawn: { R, men, balls }
  let renderT = 0, lastFxT = -1, playout = null, viewDelay = 0.06, haveFrame = false;
  // Online viewers keep just enough of a buffer for how unevenly frames arrive: the spread
  // between the luckiest and the slow (95th percentile) arrivals, plus one frame. viewDelay is
  // the floor the page sets (the guest's is small, the organiser's screen prefers smooth).
  const arrivals = [];
  let autoDelay = 0.05, autoAt = 0, starved = 0;
  function noteArrival(f) {
    arrivals.push(performance.now() / 1000 - f.t);      // clock offset + this frame's trip; only the spread matters
    if (arrivals.length > 180) arrivals.shift();
    const now = performance.now();
    if (now - autoAt < 500 || arrivals.length < 20) return;
    autoAt = now;
    const sorted = arrivals.slice().sort((a, b) => a - b);
    const spread = sorted[Math.floor(sorted.length * 0.95)] - sorted[0];
    autoDelay = clamp(spread + 1 / 60 + 0.01, 0.025, 0.25);
  }
  function effDelay() { return mode === 'host' ? viewDelay : Math.max(viewDelay, autoDelay); }
  let hud = { score: [-1, -1], clock: -2, golden: null };
  let lastFrameAt = 0;

  function pushFrame(f) {
    if (frames.length && f.t <= frames[frames.length - 1].t) return;
    frames.push(f);
    while (frames.length > 4 && frames[0].t < f.t - 3) frames.shift();
    haveFrame = true;
    lastFrameAt = performance.now();
  }
  function queueEvent(ev) {
    let i = evq.length;
    while (i > 0 && evq[i - 1].t > ev.t) i--;
    evq.splice(i, 0, ev);
  }
  function makePuppets(ev) {
    const P = () => ({ position: { x: -999, y: -999 }, angle: 0 });
    const hs = ev.R.bigHeads ? 1.42 : 1, ls = ev.R.longLegs ? 1.4 : 1;
    const men = ev.slots.map(slot => {
      const team = teamOfSlot(slot), keeper = isKeeper(slot);
      const kit = keeper ? (team ? ev.kits.keepB : ev.kits.keepA) : (team ? ev.kits.b : ev.kits.a);
      const look = ev.looks[slot] || { skin: SKINS[0], hair: HAIRS[0], style: 'crop' };
      const c = { slot, team, f: team === 0 ? 1 : -1, keeper, kit, look, hs, ls, th: THIGH_H * ls, sh: SHIN_H * ls,
        pal: palette(kit, look), torso: P(), head: P(), armNear: P(), armFar: P(),
        legs: [{ thigh: P(), shin: P(), foot: P() }, { thigh: P(), shin: P(), foot: P() }],
        kickT: 0, airT: 0, mood: 0, moodT: 0, seen: false };
      c.parts = [c.torso, c.head, c.armNear, c.armFar, c.legs[0].thigh, c.legs[0].shin, c.legs[0].foot, c.legs[1].thigh, c.legs[1].shin, c.legs[1].foot];
      return c;
    });
    const bt = BALL_TYPES[ev.R.ball] || BALL_TYPES.normal, nb = ev.R.twoBalls ? 2 : 1, ballsP = [];
    for (let i = 0; i < nb; i++) ballsP.push({ position: { x: -999, y: -999 }, angle: 0, velocity: { x: 0, y: 0 }, ballType: ev.R.ball, ballR: bt.r, trail: [], dropT: 0, warn: 0, seen: false });
    const bySlotP = [];
    men.forEach(c => { bySlotP[c.slot] = c; });
    return { round: ev.round, R: ev.R, men, balls: ballsP, bySlot: bySlotP, mods: ev.mods };
  }
  function setRound(ev) {
    const set = makePuppets(ev);
    puppetSets.set(ev.round, set);
    for (const k of Array.from(puppetSets.keys())) if (k < ev.round - 2) puppetSets.delete(k);
    if (ev.kits && !SIM) kits = ev.kits;
  }
  // interpolate the two frames around renderT into the puppets of that round
  function interpolate() {
    if (!frames.length) return null;
    let i = frames.length - 1;
    while (i > 0 && frames[i].t > renderT) i--;
    const a = frames[i], b = frames[Math.min(i + 1, frames.length - 1)];
    const span = b.t - a.t, alpha = b === a || span <= 0 ? 0 : clamp((renderT - a.t) / span, 0, 1);
    const set = puppetSets.get(a.round) || puppetSets.get(Math.max(...puppetSets.keys()));
    if (!set) return null;
    const same = b.round === a.round;
    for (const ma of a.men) {
      const c = set.bySlot[ma.slot];
      if (!c) continue;
      const mb = same ? b.men.find(x => x.slot === ma.slot) : null;
      const pa = ma.p, pb = mb ? mb.p : null;
      const jump = pb && Math.abs(pb[0] - pa[0]) + Math.abs(pb[1] - pa[1]) > 140;
      for (let k = 0; k < 10; k++) {
        const part = c.parts[k];
        if (pb && !jump) {
          part.position.x = pa[k * 3] + (pb[k * 3] - pa[k * 3]) * alpha;
          part.position.y = pa[k * 3 + 1] + (pb[k * 3 + 1] - pa[k * 3 + 1]) * alpha;
          part.angle = pa[k * 3 + 2] + angDiff(pb[k * 3 + 2], pa[k * 3 + 2]) * alpha;
        } else {
          part.position.x = pa[k * 3]; part.position.y = pa[k * 3 + 1]; part.angle = pa[k * 3 + 2];
        }
      }
      const bits = ma.bits;
      c.kickT = bits & 1 ? 1 : 0; c.airT = bits & 2 ? 1 : 0;
      c.mood = ((bits >> 2) & 3) - 1; c.moodT = c.mood !== 0 ? 1 : 0;
      c.seen = true;
    }
    for (let k = 0; k < set.balls.length; k++) {
      const pb = set.balls[k], ba = a.balls[k];
      if (!ba) { pb.seen = false; continue; }
      const bb = same ? b.balls[k] : null;
      const nx = bb && Math.abs(bb.x - ba.x) + Math.abs(bb.y - ba.y) < 160 ? ba.x + (bb.x - ba.x) * alpha : ba.x;
      const ny = bb && Math.abs(bb.x - ba.x) + Math.abs(bb.y - ba.y) < 160 ? ba.y + (bb.y - ba.y) * alpha : ba.y;
      pb.velocity.x = pb.seen ? (nx - pb.position.x) : 0;
      pb.velocity.y = pb.seen ? (ny - pb.position.y) : 0;
      pb.position.x = nx; pb.position.y = ny;
      pb.angle = bb ? ba.a + angDiff(bb.a, ba.a) * alpha : ba.a;
      pb.dropT = ba.bits & 1 ? 0.4 : 0;
      pb.warn = (ba.bits >> 1) / 127;
      pb.seen = true;
    }
    return { frame: a, set };
  }
  // advance the playout clock (online modes) and fire what it passes
  function updateNetView(dt) {
    if (!frames.length) return;
    const newest = frames[frames.length - 1].t;
    if (mode === 'host') renderT = sim.hostClock - viewDelay;
    else {
      const target = newest - effDelay();
      if (playout == null || Math.abs(playout - target) > 1) playout = target;
      playout += dt;
      playout += (target - playout) * Math.min(1, dt * 2);
      if (playout > newest) starved++;                    // ran out of frames: the picture holds still
      renderT = Math.min(playout, newest);
    }
    while (evq.length && evq[0].t <= renderT) applyEvent(evq.shift());
    for (const f of frames) {
      if (f.t > lastFxT && f.t <= renderT) { for (const e of f.fx) playFx(e); }
    }
    lastFxT = Math.max(lastFxT, renderT);
    const r = interpolate();
    if (r) {
      view = r.set;
      updateHud(r.frame.score, r.frame.clock, r.frame.golden);
    }
  }
  // a predicting player: the copy runs (and is put right), and is drawn through the puppets
  function updatePredView(dt) {
    if (!pred.update(dt)) { updateNetView(dt); return; }      // until the first full state: the plain picture (peer to peer)
    renderT = pred.tick * TICK;
    while (evq.length && evq[0].t <= renderT) applyEvent(evq.shift());
    const h = pred.hud;
    if (h) updateHud(h.score, h.clock, h.golden);
    if (frames.length) lastFxT = Math.max(lastFxT, frames[frames.length - 1].t);
    const set = puppetSets.get(pred.round);
    if (pred.frame(dt, set)) view = set; else updateNetView(dt);
  }

  /* ============================ the line, measured ============================ */
  // for the network line on the match page: how the connection and this device are doing
  const frameTimes = [];
  const fullAt = { last: 0, gaps: [] };      // full states: when the last came, and when one came late (a stall)
  function noteFullState() {
    const now = performance.now() / 1000;
    if (fullAt.last && now - fullAt.last > 0.15) fullAt.gaps.push(now);
    fullAt.last = now;
    while (fullAt.gaps.length && fullAt.gaps[0] < now - 60) fullAt.gaps.shift();
  }

  /* ============================ display events ============================ */
  function applyEvent(ev) {
    switch (ev.k) {
      case 'round':
        if (NET) setRound(ev);
        showMods(ev.mods);
        break;
      case 'count':
        banner(String(ev.n), '', -1, true);
        snd.beep(false);
        break;
      case 'kickoff':
        if (!ev.silent) { banner('Go', '', -1, true); snd.beep(true); }
        snd.whistle();
        if (!ev.silent) snd.crowdOn();
        break;
      case 'goal': {
        if (DIRECT || NET) updateHud(ev.score, null, null, ev.team);
        const name = players[ev.team].name;
        banner(ev.own ? 'Own goal' : 'Goal', ev.own ? 'Point to ' + name : name, ev.team);
        snd.goal();
        netHit[ev.side < 0 ? 0 : 1] = { t: 0, y: ev.y };
        confetti(ev.side, ev.team);
        shake(16);
        if (DIRECT) for (const c of sim.chars) { c.mood = c.team === ev.team ? 1 : -1; c.moodT = 3; }
        break;
      }
      case 'golden':
        toast('Golden goal', 'Next goal wins');
        snd.whistle();
        break;
      case 'out':
        puff(ev.x, ev.y);
        snd.whistle();
        toast('Drop ball', OUT_TEXT[ev.reason] || '');
        break;
      case 'end':
        banner(ev.winner >= 0 ? players[ev.winner].name + ' wins' : 'Full time', ev.score[0] + ' : ' + ev.score[1], ev.winner, false, 6000);
        snd.win();
        snd.crowdOff();
        if (hooks.onEndShown) hooks.onEndShown(ev);
        break;
    }
    if (hooks.onDisplayEvent) hooks.onDisplayEvent(ev);
  }
  function playFx(e) {
    switch (e.type) {
      case FX.KICK: snd.kick(e.v); spark(e.x, e.y, e.v); if (e.v > 9) shake(e.v * 0.35); break;
      case FX.BOUNCE: snd.bounce(e.v); break;
      case FX.POST: snd.post(e.v); if (e.v > 9) snd.ooh(); break;
      case FX.NET: snd.net(); break;
      case FX.HOP: snd.hop(); break;
      case FX.LAND: snd.land(); dust(e.x, e.y, 5); break;
    }
  }

  /* ============================ effects ============================ */
  let particles = [], flashes = [], shakeAmp = 0;
  const netHit = [null, null];
  function shake(a) { if (!reduceMotion) shakeAmp = Math.max(shakeAmp, a); }
  function addP(p) { if (particles.length < 500) particles.push(p); }
  function spark(x, y, power) {
    const n = Math.min(10, 3 + (power / 3) | 0);
    for (let i = 0; i < n; i++) {
      const a = vrand(0, TAU), s = vrand(2, 5) * (0.6 + power / 14);
      addP({ k: 'spark', x, y, vx: Math.cos(a) * s * 60, vy: Math.sin(a) * s * 60, life: 0.22, max: 0.22 });
    }
  }
  function dust(x, y, n) {
    for (let i = 0; i < n; i++) addP({ k: 'dust', x: x + vrand(-10, 10), y: y - 2, vx: vrand(-90, 90), vy: vrand(-160, -60), life: 0.45, max: 0.45, s: vrand(2, 4) });
  }
  function puff(x, y) {
    for (let i = 0; i < 12; i++) {
      const a = vrand(0, TAU), s = vrand(40, 140);
      addP({ k: 'puff', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5, max: 0.5, s: vrand(5, 10) });
    }
  }
  function confetti(side, team) {
    const x0 = side < 0 ? GOAL_D * 0.5 : WW - GOAL_D * 0.5, col = team === 0 ? kits.hexA : kits.hexB;
    const cols = [col, '#ffffff', '#ffd43b', col];
    const top = barUnderFor(view && view.R ? view.R.goalScale : 1) - BAR_T;
    for (let i = 0; i < 90; i++) {
      addP({ k: 'conf', x: x0 + vrand(-50, 50), y: top + vrand(-20, 40), vx: vrand(-260, 260) - side * 120, vy: vrand(-520, -140),
        life: vrand(1.4, 2.4), max: 2.4, rot: vrand(0, TAU), vr: vrand(-12, 12), c: cols[i % cols.length], s: vrand(4, 8) });
    }
    for (let j = 0; j < 14; j++) flashes.push({ x: vrand(0, WW), y: vrand(GROUND_Y - 170, GROUND_Y - 50), t: vrand(0, 0.5) });
  }
  function updateFx(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.k === 'dust') p.vy += 700 * dt;
      else if (p.k === 'conf') { p.vy += 420 * dt; p.vx *= 0.985; p.vy = Math.min(p.vy, 160); p.rot += p.vr * dt; }
      else { p.vx *= 0.9; p.vy *= 0.9; }
    }
    for (let j = flashes.length - 1; j >= 0; j--) { flashes[j].t -= dt; if (flashes[j].t < -0.09) flashes.splice(j, 1); }
    if (Math.random() < 0.03) flashes.push({ x: vrand(0, WW), y: vrand(GROUND_Y - 170, GROUND_Y - 50), t: 0 });
    for (let k = 0; k < 2; k++) if (netHit[k]) { netHit[k].t += dt; if (netHit[k].t > 1.6) netHit[k] = null; }
    shakeAmp *= Math.pow(0.002, dt);
    if (shakeAmp < 0.2) shakeAmp = 0;
    const list = view ? view.balls : [];
    for (const bl of list) {
      const sp = Math.abs(bl.velocity.x) + Math.abs(bl.velocity.y);
      if (sp > 14) { bl.trail.push(bl.position.x, bl.position.y); if (bl.trail.length > 12) bl.trail.splice(0, 2); }
      else if (bl.trail.length) bl.trail.splice(0, 2);
    }
  }

  /* ============================ drawing ============================ */
  let K = 1;
  const bg = document.createElement('canvas');
  let bgDirty = true;
  function rr(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function boardLabels(n) {
    const a = 'GO ' + players[0].name.toUpperCase(), b = 'GO ' + players[1].name.toUpperCase();
    const title = (opts.title || 'THE COTERIE CUP').toUpperCase(), sub = (opts.subtitle || 'ONE BUTTON').toUpperCase();
    return { 3: [a, title, b], 4: [a, title, sub, b], 5: [a, sub, title, sub, b] }[n];
  }
  function buildBackground() {
    bgDirty = false;
    bg.width = canvas.width; bg.height = canvas.height;
    const b = bg.getContext('2d');
    b.setTransform(K, 0, 0, K, 0, 0);
    const vr = makeRng(20261009);
    const standTop = GROUND_Y - 186, boardTop = GROUND_Y - 38;
    let i, x, y;
    const g = b.createLinearGradient(0, 0, 0, GROUND_Y);
    g.addColorStop(0, '#03051a'); g.addColorStop(0.42, '#0b1137'); g.addColorStop(0.75, '#1a1b52'); g.addColorStop(1, '#2b2468');
    b.fillStyle = g; b.fillRect(0, 0, WW, GROUND_Y);
    for (i = 0; i < 90; i++) {
      b.fillStyle = 'rgba(222,228,255,' + (0.12 + vr() * 0.5).toFixed(2) + ')';
      const s = vr() < 0.86 ? 1.3 : 2.2;
      b.fillRect(vr() * WW, vr() * (standTop - 40), s, s);
    }
    b.globalCompositeOperation = 'lighter';
    const towers = [WW * 0.075, WW * 0.925];
    for (i = 0; i < 2; i++) {
      const rg = b.createRadialGradient(towers[i], 64, 8, towers[i], 64, 560);
      rg.addColorStop(0, 'rgba(255,240,205,0.5)'); rg.addColorStop(0.18, 'rgba(255,232,190,0.17)'); rg.addColorStop(1, 'rgba(255,232,190,0)');
      b.fillStyle = rg; b.fillRect(0, 0, WW, GROUND_Y);
    }
    b.globalCompositeOperation = 'source-over';
    for (i = 0; i < 2; i++) {
      x = towers[i];
      b.fillStyle = '#141838'; b.fillRect(x - 4, 72, 8, standTop - 60);
      b.save(); b.translate(x, 60);
      b.fillStyle = '#1b2046'; b.fillRect(-52, -20, 104, 38);
      b.shadowColor = 'rgba(255,244,214,0.95)'; b.shadowBlur = 16; b.fillStyle = '#fff8e2';
      for (let r = 0; r < 2; r++) for (let q = 0; q < 5; q++) { b.beginPath(); b.arc(-40 + q * 20, -8 + r * 16, 6, 0, TAU); b.fill(); }
      b.shadowBlur = 0; b.restore();
    }
    const sg = b.createLinearGradient(0, standTop, 0, boardTop);
    sg.addColorStop(0, '#11143a'); sg.addColorStop(1, '#1d1f4d');
    b.fillStyle = sg; b.fillRect(0, standTop, WW, boardTop - standTop);
    b.fillStyle = '#272a63'; b.fillRect(0, standTop - 6, WW, 6);
    b.fillStyle = 'rgba(255,236,190,0.55)'; b.fillRect(0, standTop - 1, WW, 1.5);
    const heads = ['#e8c3a3', '#c79f7f', '#8d5f3e', '#5e3b24', '#f1d4bd'];
    const neutral = ['#2a2f5e', '#3a3f70', '#c9cbe0', '#1f2448', '#5b6098', '#7a4a8c'];
    for (y = standTop + 16; y < boardTop - 6; y += 10) {
      const depth = (y - standTop) / (boardTop - standTop);
      for (x = (((y / 10) | 0) % 2) * 4.5; x < WW; x += 9) {
        if (vr() < 0.1) continue;
        const home = x < WW / 2;
        const col = vr() < 0.44 ? (home ? kits.hexA : kits.hexB) : neutral[(vr() * neutral.length) | 0];
        b.globalAlpha = 0.32 + depth * 0.42;
        b.fillStyle = col; b.beginPath(); b.ellipse(x, y + 4, 4.2, 3.4, 0, 0, TAU); b.fill();
        b.fillStyle = heads[(vr() * heads.length) | 0]; b.beginPath(); b.arc(x, y - 1.5, 2.5, 0, TAU); b.fill();
        if (vr() < 0.05) { b.fillStyle = col; b.fillRect(x - 0.8, y - 9, 1.6, 6); }
      }
    }
    b.globalAlpha = 1;
    const shadeTop = b.createLinearGradient(0, standTop, 0, standTop + 60);
    shadeTop.addColorStop(0, 'rgba(5,6,26,0.6)'); shadeTop.addColorStop(1, 'rgba(5,6,26,0)');
    b.fillStyle = shadeTop; b.fillRect(0, standTop, WW, 60);
    // LED boards between the goals
    b.fillStyle = '#050822'; b.fillRect(0, boardTop, WW, GROUND_Y - boardTop);
    const bh = GROUND_Y - boardTop - 7;
    b.fillStyle = '#0a1036';
    b.fillRect(2, boardTop + 3, GOAL_D - 4, bh); b.fillRect(WW - GOAL_D + 2, boardTop + 3, GOAL_D - 4, bh);
    const span = WW - 2 * GOAL_D, n = clamp(Math.round(span / 212), 3, 5), pw = span / n, labels = boardLabels(n);
    b.textAlign = 'center'; b.textBaseline = 'middle';
    try { b.letterSpacing = '2px'; } catch (e) { }
    for (i = 0; i < n; i++) {
      x = GOAL_D + i * pw;
      b.fillStyle = '#0a1036'; b.fillRect(x + 2, boardTop + 3, pw - 4, bh);
      const lab = labels[i];
      const lc = i === 0 ? kits.hexA : i === n - 1 ? kits.hexB : (lab === labels[Math.floor(n / 2)] ? '#ffd43b' : '#eceaff');
      let size = 17;
      b.font = '900 ' + size + 'px ' + bodyFont();
      while (b.measureText(lab).width > pw - 22 && size > 9) { size--; b.font = '900 ' + size + 'px ' + bodyFont(); }
      b.shadowColor = lc; b.shadowBlur = 9; b.fillStyle = lc;
      b.fillText(lab, x + pw / 2, boardTop + (GROUND_Y - boardTop) / 2 - 1);
      b.shadowBlur = 0;
    }
    try { b.letterSpacing = '0px'; } catch (e) { }
    for (x = 0, i = 0; x < WW; x += 64, i++) { b.fillStyle = i % 2 ? '#22863d' : '#2a9849'; b.fillRect(x, GROUND_Y, 64, WH - GROUND_Y); }
    const pg = b.createLinearGradient(0, GROUND_Y, 0, WH);
    pg.addColorStop(0, 'rgba(210,255,200,0.08)'); pg.addColorStop(1, 'rgba(0,14,6,0.45)');
    b.fillStyle = pg; b.fillRect(0, GROUND_Y, WW, WH - GROUND_Y);
    b.strokeStyle = 'rgba(245,255,245,0.5)'; b.lineWidth = 2.5;
    b.beginPath(); b.moveTo(0, GROUND_Y + 3); b.lineTo(WW, GROUND_Y + 3); b.stroke();
    b.beginPath(); b.moveTo(WW / 2, GROUND_Y + 3); b.lineTo(WW / 2, WH); b.stroke();
    b.beginPath(); b.ellipse(WW / 2, GROUND_Y + 64, 124, 36, 0, 0, TAU); b.stroke();
    b.beginPath(); b.moveTo(GOAL_D, GROUND_Y + 3); b.lineTo(GOAL_D - 34, WH); b.stroke();
    b.beginPath(); b.moveTo(WW - GOAL_D, GROUND_Y + 3); b.lineTo(WW - GOAL_D + 34, WH); b.stroke();
    b.fillStyle = 'rgba(160,245,170,0.6)'; b.fillRect(0, GROUND_Y, WW, 2);
  }
  function rippleDx(rp, x, y, side) {
    const d = Math.abs(y - rp.y) + Math.abs(x - (side < 0 ? GOAL_D * 0.4 : WW - GOAL_D * 0.4)) * 0.6;
    const amp = 11 * Math.exp(-rp.t * 2.6);
    return -side * amp * Math.exp(-d / 70) * Math.cos(d * 0.12 - rp.t * 18);
  }
  function netLattice(side, alpha, rp, gs) {
    const x0 = side < 0 ? 0 : WW - GOAL_D, x1 = side < 0 ? GOAL_D - 4 : WW;
    const top = barUnderFor(gs), bot = GROUND_Y, h = bot - top, gap = 15;
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, top, x1 - x0, bot - top); ctx.clip();
    ctx.strokeStyle = 'rgba(232,238,255,' + alpha + ')'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = -h; k < (x1 - x0) + h; k += gap) {
      for (let dir = -1; dir <= 1; dir += 2) {
        if (!rp) { ctx.moveTo(x0 + k, top); ctx.lineTo(x0 + k + dir * h, bot); continue; }
        let first = true;
        for (let y = top; y <= bot + 0.1; y += 12) {
          const x = x0 + k + dir * (y - top), dx = rippleDx(rp, x, y, side);
          if (first) { ctx.moveTo(x + dx, y); first = false; } else ctx.lineTo(x + dx, y);
        }
      }
    }
    ctx.stroke(); ctx.restore();
  }
  function tube(x, y, w, h, r) {
    rr(x, y, w, h, r);
    ctx.fillStyle = '#f4f6ff'; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(80,96,170,0.28)';
    if (w > h) ctx.fillRect(x, y + h * 0.6, w, h); else ctx.fillRect(x + w * 0.62, y, w, h);
    ctx.restore();
    ctx.lineWidth = 2; ctx.strokeStyle = OUTLINE; ctx.stroke();
  }
  function drawGoalBack(side, gs) {
    const under = barUnderFor(gs), top = under - BAR_T;
    ctx.fillStyle = 'rgba(190,205,255,0.07)';
    ctx.fillRect(side < 0 ? 0 : WW - GOAL_D, under, GOAL_D, GROUND_Y - under);
    netLattice(side, 0.12, null, gs);
    const bx = side < 0 ? 9 : WW - 9;
    ctx.strokeStyle = 'rgba(225,230,255,0.55)'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(bx, top + 6); ctx.lineTo(bx, GROUND_Y); ctx.stroke();
  }
  function drawGoalFront(side, gs) {
    const under = barUnderFor(gs), top = under - BAR_T;
    netLattice(side, 0.3, netHit[side < 0 ? 0 : 1], gs);
    const px = side < 0 ? GOAL_D - BAR_T / 2 : WW - GOAL_D + BAR_T / 2;
    tube(px - 6, under - 2, 12, GROUND_Y - under + 6, 5);
    tube(side < 0 ? -6 : WW - GOAL_D, top, GOAL_D + 6, BAR_T, 7);
  }
  function limb(b, w, h, r, top, bottom, split) {
    ctx.save();
    ctx.translate(b.position.x, b.position.y); ctx.rotate(b.angle);
    rr(-w / 2, -h / 2, w, h, r);
    ctx.fillStyle = bottom; ctx.fill();
    if (split > 0) { ctx.save(); ctx.clip(); ctx.fillStyle = top; ctx.fillRect(-w / 2, -h / 2, w, h * split); ctx.restore(); }
    ctx.lineWidth = LW; ctx.strokeStyle = OUTLINE; ctx.stroke();
    ctx.restore();
  }
  function drawArm(c, a, far) {
    const P = c.pal;
    limb(a, ARM_W, ARM_H, 5, far ? P.shirtD : P.shirt, far ? P.skinD : P.skin, 0.42);
    const d = ARM_H / 2 - 1, hx = a.position.x - Math.sin(a.angle) * d, hy = a.position.y + Math.cos(a.angle) * d;
    ctx.beginPath(); ctx.arc(hx, hy, P.gloves ? 7 : 5.2, 0, TAU);
    ctx.fillStyle = P.gloves ? (far ? P.glovesD : P.gloves) : (far ? P.skinD : P.skin);
    ctx.fill(); ctx.lineWidth = LW; ctx.strokeStyle = OUTLINE; ctx.stroke();
  }
  function drawBoot(b, color, f) {
    ctx.save();
    ctx.translate(b.position.x, b.position.y); ctx.rotate(b.angle);
    rr(-FOOT_W / 2, -FOOT_H / 2, FOOT_W, FOOT_H, 5);
    ctx.fillStyle = color; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(0,0,20,0.4)'; ctx.fillRect(-FOOT_W / 2, FOOT_H / 2 - 3, FOOT_W, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.fillRect(f > 0 ? -FOOT_W / 2 : FOOT_W / 2 - 7, -FOOT_H / 2, 7, FOOT_H - 3);
    ctx.restore();
    ctx.lineWidth = LW; ctx.strokeStyle = OUTLINE; ctx.stroke();
    ctx.restore();
  }
  function drawLeg(c, L, far) {
    const P = c.pal;
    drawBoot(L.foot, far ? P.bootsD : P.boots, c.f);
    limb(L.shin, SHIN_W, c.sh, 5, far ? P.skinD : P.skin, far ? P.socksD : P.socks, 0.16);
    limb(L.thigh, THIGH_W, c.th, 6, far ? P.shortsD : P.shorts, far ? P.skinD : P.skin, 0.6);
  }
  function drawTorso(c) {
    const t = c.torso, P = c.pal, f = c.f, w = TORSO_W, h = TORSO_H;
    ctx.save();
    ctx.translate(t.position.x, t.position.y); ctx.rotate(t.angle);
    rr(-w / 2, -h / 2, w, h, 9);
    ctx.fillStyle = P.shirt; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(10,8,40,0.18)'; ctx.fillRect(f > 0 ? -w / 2 : w / 2 - 8, -h / 2, 8, h);
    ctx.fillStyle = P.shorts; ctx.fillRect(-w / 2, h / 2 - 12, w, 12);
    ctx.fillStyle = P.trim; ctx.fillRect(f * 3 - 7, -h / 2, 14, 4);
    if (c.keeper) {
      ctx.font = '900 19px ' + bodyFont(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('1', 0, -1);
    }
    ctx.restore();
    ctx.lineWidth = LW; ctx.strokeStyle = OUTLINE; ctx.stroke();
    ctx.restore();
  }
  function drawHead(c, look) {
    const h = c.head, r = HEAD_R * c.hs, f = c.f, P = c.pal, st = c.look.style;
    ctx.save();
    ctx.translate(h.position.x, h.position.y); ctx.rotate(h.angle);
    ctx.lineWidth = LW; ctx.strokeStyle = OUTLINE;
    if (st === 'puff') {
      ctx.fillStyle = P.hair; ctx.beginPath();
      ctx.arc(-f * r * 0.5, -r * 0.55, r * 0.62, 0, TAU); ctx.arc(0, -r * 0.82, r * 0.66, 0, TAU); ctx.arc(f * r * 0.42, -r * 0.6, r * 0.55, 0, TAU);
      ctx.fill(); ctx.stroke();
    } else if (st === 'pony') {
      ctx.fillStyle = P.hair; ctx.beginPath(); ctx.arc(-f * r * 1.02, -r * 0.18, r * 0.32, 0, TAU); ctx.fill(); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU);
    ctx.fillStyle = P.skin; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(60,20,50,0.14)'; ctx.beginPath(); ctx.arc(-f * r * 0.62, r * 0.25, r * 0.85, 0, TAU); ctx.fill();
    if (st !== 'bald') {
      ctx.fillStyle = P.hair;
      if (st === 'buzz') ctx.globalAlpha = 0.62;
      ctx.beginPath(); ctx.ellipse(-f * r * 0.16, -r * 0.74, r * 1.08, r * 0.6, 0, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath(); ctx.ellipse(f * r * 0.1, -r * 0.62, r * 0.36, r * 0.15, -0.3 * f, 0, TAU); ctx.fill();
    }
    ctx.restore();
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
    if (st === 'quiff') { ctx.fillStyle = P.hair; ctx.beginPath(); ctx.ellipse(f * r * 0.42, -r * 0.9, r * 0.42, r * 0.26, f * 0.4, 0, TAU); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = P.skinD; ctx.beginPath(); ctx.ellipse(-f * r * 0.42, r * 0.1, r * 0.14, r * 0.2, 0, 0, TAU); ctx.fill(); ctx.stroke();
    const lx = look ? look.x : f, ly = look ? look.y : 0, ex = [f * r * 0.12, f * r * 0.56], ey = -r * 0.04;
    for (let i = 0; i < 2; i++) {
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.ellipse(ex[i], ey, r * 0.17, r * 0.21, 0, 0, TAU); ctx.fill();
      ctx.lineWidth = 1.6; ctx.stroke();
      ctx.fillStyle = OUTLINE; ctx.beginPath(); ctx.arc(ex[i] + lx * r * 0.075, ey + ly * r * 0.09, r * 0.085, 0, TAU); ctx.fill();
    }
    const effort = c.kickT > 0 || c.airT > 0.25, mood = c.moodT > 0 ? c.mood : 0;
    ctx.strokeStyle = OUTLINE; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
    const tilt = mood < 0 ? -0.18 : effort ? 0.2 : 0;
    ctx.beginPath();
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1;
      ctx.moveTo(ex[i] - r * 0.15, ey - r * 0.3 - s * tilt * r * 0.3 * f);
      ctx.lineTo(ex[i] + r * 0.15, ey - r * 0.3 + s * tilt * r * 0.3 * f);
    }
    ctx.stroke();
    const mx = f * r * 0.38, my = r * 0.46;
    ctx.beginPath();
    if (mood > 0) { ctx.arc(mx, my - r * 0.1, r * 0.22, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke(); }
    else if (mood < 0) { ctx.arc(mx, my + r * 0.16, r * 0.18, 1.15 * Math.PI, 1.85 * Math.PI); ctx.stroke(); }
    else if (effort) { ctx.fillStyle = '#3a0d1e'; ctx.ellipse(mx, my, r * 0.11, r * 0.14, 0, 0, TAU); ctx.fill(); }
    else { ctx.moveTo(mx - r * 0.12, my); ctx.lineTo(mx + r * 0.12, my); ctx.stroke(); }
    ctx.lineCap = 'butt';
    ctx.restore();
  }
  function drawMan(c, ballsList) {
    let look = null;
    const ball = nearestBallOf(ballsList, c);
    if (ball) {
      const dx = ball.position.x - c.head.position.x, dy = ball.position.y - c.head.position.y;
      const ca = Math.cos(-c.head.angle), sa = Math.sin(-c.head.angle);
      const lx = dx * ca - dy * sa, ly = dx * sa + dy * ca, d = Math.sqrt(lx * lx + ly * ly) || 1;
      look = { x: lx / d, y: ly / d };
    }
    drawArm(c, c.armFar, true);
    drawLeg(c, c.legs[1], true);
    drawTorso(c);
    drawLeg(c, c.legs[0], false);
    drawHead(c, look);
    drawArm(c, c.armNear, false);
  }
  function drawBall(b) {
    const p = b.position, r = b.ballR, t = b.ballType;
    if (b.trail.length > 2) {
      for (let i = 0; i < b.trail.length; i += 2) {
        const k = (i + 2) / (b.trail.length + 2);
        ctx.fillStyle = 'rgba(235,240,255,' + (0.16 * k).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(b.trail[i], b.trail[i + 1], r * (0.55 + 0.4 * k), 0, TAU); ctx.fill();
      }
    }
    if (b.dropT > 0) {
      ctx.strokeStyle = 'rgba(255,212,59,' + Math.min(0.8, b.dropT / 0.7 * 0.8).toFixed(3) + ')'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 10 + (0.7 - Math.min(0.7, b.dropT)) * 30, 0, TAU); ctx.stroke();
    }
    if (b.warn > 0) {
      // about to be dropped again: the ring winds down to nothing
      const rr = ballReach(t) + 11, a0 = -Math.PI / 2;
      ctx.save();
      ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(11,14,38,0.35)';
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, TAU); ctx.stroke();
      ctx.strokeStyle = '#ffd43b';
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, a0, a0 + (1 - b.warn) * TAU); ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.lineWidth = LW; ctx.strokeStyle = OUTLINE;
    const shape = (BALL_TYPES[t] || BALL_TYPES.normal).shape;
    if (shape) { drawLongBall(t, r, b.angle); ctx.restore(); return; }
    ctx.save();
    ctx.rotate(b.angle);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU);
    if (t === 'beach') {
      ctx.fillStyle = '#ffffff'; ctx.fill();
      const cols = ['#14b8cc', '#ffd43b', '#ff7a1a'];
      for (let i = 0; i < 6; i += 2) { ctx.fillStyle = cols[i / 2]; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, i * TAU / 6, (i + 1) * TAU / 6); ctx.closePath(); ctx.fill(); }
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(0, 0, r * 0.2, 0, TAU); ctx.fill();
    } else if (t === 'balloon') {
      ctx.fillStyle = '#ff5c8a'; ctx.fill();
    } else if (t === 'baseball') {
      ctx.fillStyle = '#f7f3e8'; ctx.fill();
      ctx.save(); ctx.clip();
      // two curved red seams with their stitches
      ctx.strokeStyle = '#d7263d'; ctx.lineCap = 'round';
      for (const sd of [-1, 1]) {
        const cx = sd * r * 1.32, rad = r * 0.92;
        ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(cx, 0, rad, sd < 0 ? -0.72 : Math.PI - 0.72, sd < 0 ? 0.72 : Math.PI + 0.72); ctx.stroke();
        ctx.lineWidth = 1.3; ctx.beginPath();
        for (let k = -3; k <= 3; k++) {
          const a = (sd < 0 ? 0 : Math.PI) + k * 0.2, x = cx + Math.cos(a) * rad, y = Math.sin(a) * rad;
          const nx = -Math.cos(a), ny = -Math.sin(a);
          ctx.moveTo(x - ny * 2.2, y + nx * 2.2); ctx.lineTo(x + nx * 2.6, y + ny * 2.6); ctx.lineTo(x + ny * 2.2, y - nx * 2.2);
        }
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
      ctx.restore();
    } else {
      // football: white with dark panels
      ctx.fillStyle = '#f6f6fb'; ctx.fill();
      ctx.save(); ctx.clip();
      ctx.fillStyle = '#1b2147';
      polygon(0, 0, r * 0.36, 5, -Math.PI / 2); ctx.fill();
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + i * TAU / 5;
        polygon(Math.cos(a) * r * 1.02, Math.sin(a) * r * 1.02, r * 0.36, 5, a + Math.PI); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(27,33,71,0.55)'; ctx.lineWidth = Math.max(1, r * 0.06); ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + i * TAU / 5;
        ctx.moveTo(Math.cos(a) * r * 0.36, Math.sin(a) * r * 0.36); ctx.lineTo(Math.cos(a) * r * 0.68, Math.sin(a) * r * 0.68);
        const b2 = a + TAU / 10;
        ctx.moveTo(Math.cos(b2) * r * 0.62, Math.sin(b2) * r * 0.62); ctx.lineTo(Math.cos(b2) * r * 1.05, Math.sin(b2) * r * 1.05);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.lineWidth = LW; ctx.strokeStyle = OUTLINE;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
    ctx.restore();
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.42, r * 0.08, 0, 0, r);
    g.addColorStop(0, 'rgba(255,255,255,0.6)'); g.addColorStop(0.45, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(10,12,50,0.32)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r - 1, 0, TAU); ctx.fill();
    if (t === 'balloon') {
      ctx.strokeStyle = 'rgba(240,240,255,0.7)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, r); ctx.quadraticCurveTo(6 * Math.sin(performance.now() / 330), r + 16, 0, r + 30); ctx.stroke();
    }
    ctx.restore();
  }
  function polygon(cx, cy, rad, n, rot) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const a = rot + i * TAU / n; ctx[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); }
    ctx.closePath();
  }
  // rugby ball (white, rounded ends) and American football (brown, pointed, laced)
  function longBallPath(t, r) {
    const L = BALL_TYPES[t].half;
    ctx.beginPath();
    if (t === 'american') {
      ctx.moveTo(-L, 0); ctx.quadraticCurveTo(0, -r * 2, L, 0); ctx.quadraticCurveTo(0, r * 2, -L, 0); ctx.closePath();
    } else ctx.ellipse(0, 0, L + r, r, 0, 0, TAU);
  }
  function drawLongBall(t, r, angle) {
    const L = BALL_TYPES[t].half;
    ctx.rotate(angle);
    longBallPath(t, r);
    ctx.fillStyle = t === 'american' ? '#8b4a24' : '#f5f6fa'; ctx.fill();
    ctx.save(); ctx.clip();
    if (t === 'american') {
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.ellipse(-L * 0.15, -r * 0.42, L * 0.6, r * 0.32, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#f4f1ea'; ctx.fillRect(-L * 0.66, -r, 3.5, r * 2); ctx.fillRect(L * 0.66 - 3.5, -r, 3.5, r * 2);
      ctx.strokeStyle = 'rgba(40,16,4,0.45)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-L, 0); ctx.quadraticCurveTo(0, -r * 0.25, L, 0); ctx.stroke();
      ctx.strokeStyle = '#f4f1ea'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.beginPath();
      ctx.moveTo(-L * 0.3, -r * 0.42); ctx.lineTo(L * 0.3, -r * 0.42);
      for (let i = -2; i <= 2; i++) { const x = i * L * 0.13; ctx.moveTo(x, -r * 0.6); ctx.lineTo(x, -r * 0.24); }
      ctx.stroke(); ctx.lineCap = 'butt';
    } else {
      ctx.fillStyle = '#1f3fae'; ctx.beginPath(); ctx.ellipse(0, 0, L * 0.42, r * 1.2, 0.5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffd43b'; ctx.fillRect(-L - r, -r * 0.12, (L + r) * 2, r * 0.24);
      ctx.strokeStyle = 'rgba(27,33,71,0.35)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(0, 0, L + r, r * 0.5, 0, Math.PI, TAU); ctx.stroke();
    }
    ctx.restore();
    const g = ctx.createLinearGradient(0, -r, 0, r);
    g.addColorStop(0, 'rgba(255,255,255,0.35)'); g.addColorStop(0.45, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(10,12,50,0.3)');
    longBallPath(t, r); ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = LW; ctx.strokeStyle = OUTLINE; ctx.stroke();
  }
  function drawShadows(men, bl) {
    ctx.fillStyle = '#000a04';
    for (const c of men) {
      const low = Math.max(c.legs[0].foot.position.y, c.legs[1].foot.position.y), s = clamp(1 - Math.max(0, GROUND_Y - low) / 520, 0.25, 1);
      ctx.globalAlpha = 0.34 * s;
      ctx.beginPath(); ctx.ellipse(c.torso.position.x, GROUND_Y + 5, 30 * s + 6, 6 * s + 1, 0, 0, TAU); ctx.fill();
    }
    for (const b of bl) {
      const s = clamp(1 - Math.max(0, GROUND_Y - b.position.y - b.ballR) / 520, 0.2, 1);
      ctx.globalAlpha = 0.34 * s;
      ctx.beginPath(); ctx.ellipse(b.position.x, GROUND_Y + 5, ballReach(b.ballType) * s + 4, 5 * s + 1, 0, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function drawFx() {
    for (const p of particles) {
      const a = clamp(p.life / p.max, 0, 1);
      if (p.k === 'spark') {
        ctx.strokeStyle = 'rgba(255,248,220,' + a.toFixed(3) + ')'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
      } else if (p.k === 'dust') {
        ctx.fillStyle = 'rgba(140,220,120,' + a.toFixed(3) + ')'; ctx.fillRect(p.x, p.y, p.s, p.s);
      } else if (p.k === 'puff') {
        ctx.fillStyle = 'rgba(240,244,255,' + (a * 0.7).toFixed(3) + ')'; ctx.beginPath(); ctx.arc(p.x, p.y, p.s * (1.6 - a), 0, TAU); ctx.fill();
      } else if (p.k === 'conf') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.min(1, p.life * 2);
        ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    for (const fl of flashes) {
      if (fl.t > 0) continue;
      ctx.fillStyle = 'rgba(255,255,255,' + clamp(1 + fl.t * 11, 0, 1).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(fl.x, fl.y, 2.6, 0, TAU); ctx.fill();
    }
  }
  function chevron(x, y, s, fill) {
    ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s * 0.6); ctx.lineTo(x - s, y + s * 0.6); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = OUTLINE; ctx.stroke();
  }
  function render() {
    if (bgDirty) buildBackground();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bg, 0, 0);
    const v = view;
    if (!v) return;
    const sx = shakeAmp ? (Math.random() * 2 - 1) * shakeAmp : 0, sy = shakeAmp ? (Math.random() * 2 - 1) * shakeAmp : 0;
    ctx.setTransform(K, 0, 0, K, sx * K, sy * K);
    const gs = v.R.goalScale;
    const men = NET ? v.men.filter(c => c.seen) : v.men, bl = NET ? v.balls.filter(b => b.seen) : v.balls;
    drawShadows(men, bl);
    drawGoalBack(-1, gs); drawGoalBack(1, gs);
    for (const c of men) if (c.keeper) drawMan(c, bl);
    for (const b of bl) drawBall(b);
    for (const c of men) if (!c.keeper) drawMan(c, bl);
    drawGoalFront(-1, gs); drawGoalFront(1, gs);
    drawFx();
    for (const b of bl) {
      const ey = ballReach(b.ballType);
      if (b.position.y + ey > 2) continue;
      chevron(clamp(b.position.x, 18, WW - 18), 16, 8 + Math.min(7, -b.position.y / 40), '#ffffff');
    }
    for (const c of men) if (c.head.position.y + HEAD_R * c.hs < 0) chevron(clamp(c.head.position.x, 14, WW - 14), 10, 6, c.team === 0 ? kits.hexA : kits.hexB);
  }

  /* ============================ HUD ============================ */
  let toastTimer = 0, bannerTimer = 0, hintTimer = 0;
  function flagHtml(code) { return code ? '<img alt="" src="/flags/' + esc(code) + '.svg">' : ''; }
  function setPlayersHud() {
    el.nameA.textContent = players[0].name; el.nameB.textContent = players[1].name;
    el.flagA.innerHTML = flagHtml(players[0].flag); el.flagB.innerHTML = flagHtml(players[1].flag);
    el.dotA.style.background = kits.hexA; el.dotB.style.background = kits.hexB;
    el.sa.style.color = readable(kits.hexA); el.sb.style.color = readable(kits.hexB);
    // the pads sit outside the frame: colour them directly, a right-hand player's pad in its own team colour
    el.padA.style.background = localTeam === 1 ? kits.hexB : kits.hexA;
    el.padB.style.background = kits.hexB;
    bgDirty = true;
  }
  function updateHud(sc, clock, gold, bump) {
    if (sc && (sc[0] !== hud.score[0] || sc[1] !== hud.score[1])) {
      const changed = hud.score[0] >= 0 ? (sc[0] !== hud.score[0] ? 0 : 1) : -1;
      hud.score = sc.slice();
      el.sa.textContent = sc[0]; el.sb.textContent = sc[1];
      const which = bump != null ? bump : changed;
      if (which >= 0) { const e = which === 0 ? el.sa : el.sb; e.classList.remove('bump'); void e.offsetWidth; e.classList.add('bump'); }
    }
    if (clock != null || gold != null) {
      const label = gold ? 'Golden goal' : clock >= 0 ? fmtClock(clock) : '';
      if (label !== hud.clock) {
        hud.clock = label;
        el.clock.textContent = label;
        el.clock.hidden = !label;
        el.clock.classList.toggle('gold', !!gold);
      }
    }
  }
  function showMods(mods) {
    el.mods.textContent = '';
    for (const t of mods || []) { const s = document.createElement('span'); s.textContent = t; el.mods.appendChild(s); }
    el.mods.hidden = !(mods && mods.length);
  }
  function toast(title, sub) {
    el.toastT.textContent = title; el.toastS.textContent = sub || '';
    el.toast.hidden = false;
    el.toast.classList.remove('show'); void el.toast.offsetWidth; el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2300);
  }
  function banner(title, sub, team, quick, ms) {
    el.bannerT.textContent = title; el.bannerS.textContent = sub || '';
    el.banner.style.setProperty('--team', team === 0 ? readable(kits.hexA) : team === 1 ? readable(kits.hexB) : '#ffd43b');
    el.banner.classList.toggle('quick', !!quick);
    el.banner.hidden = false;
    el.banner.classList.remove('show'); void el.banner.offsetWidth; el.banner.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { el.banner.hidden = true; }, ms || (quick ? 800 : 2200));
  }
  function hint(text, ms) {
    el.hint.textContent = text; el.hint.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { el.hint.hidden = true; }, ms || 4500);
  }
  function syncMute() {
    el.mute.setAttribute('aria-pressed', Snd.muted ? 'true' : 'false');
    el.mute.setAttribute('aria-label', Snd.muted ? 'Sound off' : 'Sound on');
  }

  /* ============================ input ============================ */
  const KEYS_ONE = { KeyW: 'both', Space: 'both', ArrowUp: 'both', Enter: 'both', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
  const KEYS_TWO = { KeyW: [0, 1], KeyA: [0], KeyD: [1], ArrowUp: [2, 3], ArrowLeft: [2], ArrowRight: [3] };
  function slotsFor(which) {
    // left/right key = the left-most / right-most man of my team
    if (localTeam === 0) return which === 'both' ? [0, 1] : which === 'left' ? [0] : [1];
    return which === 'both' ? [2, 3] : which === 'left' ? [2] : [3];
  }
  function localPress(slots) {
    if (!inputOn || paused || destroyed) return;
    Snd.unlock();
    // predicting: the copy runs the press on its next tick (or a few later with an input delay),
    // and the authority on that same tick; the predictor sends it (onPress)
    if (PRED) { if (pred.on) pred.press(slots); return; }
    // peer to peer with equal delay: the host jumps him with the lean this picture showed
    if (mode === 'guest') { if (hooks.onPress) hooks.onPress(slots, renderT); return; }
    if (!SIM) return;
    if (mode === 'host' && inputDelay > 0) {
      // the host's own press waits as long as everybody's, with the lean his man has now
      const done = sim.ticks, ss = slots.filter(s => sim.bySlot[s]);
      const r = sim.queuePress(0, ss, done + 1 + inputDelay, 0, ss.map(s => angDiff(sim.bySlot[s].torso.getAngle(), 0)), done);
      if (hooks.onHostPress && !r.dropped) r.slots.forEach((s, i) => hooks.onHostPress(s, r.at, r.leans[i], sim.round));
      return;
    }
    for (const s of slots) if (sim.bySlot[s]) sim.press(sim.bySlot[s], mode === 'host' ? leanSeen(sim.bySlot[s], renderT) : null);
  }
  function onKey(e) {
    if (destroyed) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // M mutes; in a grid of pitches only the one with sound answers, or N pitches would toggle it N times
    if (e.code === 'KeyM') { if (soundOn) { Snd.setMuted(!Snd.muted); syncMute(); } return; }
    if ((e.code === 'Escape' || e.code === 'KeyP') && (mode === 'practice' || mode === 'local2p')) { if (hooks.onPauseKey) hooks.onPauseKey(); return; }
    if (mode === 'spectator' || mode === 'demo') return;
    if (mode === 'local2p') {
      const s = KEYS_TWO[e.code];
      if (s) { e.preventDefault(); if (!e.repeat) localPress(s); }
      return;
    }
    const w = KEYS_ONE[e.code];
    if (w) { e.preventDefault(); if (!e.repeat) localPress(slotsFor(w)); }
  }
  window.addEventListener('keydown', onKey);
  function onCanvasDown(e) {
    Snd.unlock();
    if (e.pointerType !== 'touch' || mode === 'spectator' || mode === 'demo') return;
    e.preventDefault();
    if (mode === 'local2p') {
      const r = canvas.getBoundingClientRect();
      localPress(e.clientX - r.left < r.width / 2 ? [0, 1] : [2, 3]);
    } else localPress(slotsFor('both'));
  }
  canvas.addEventListener('pointerdown', onCanvasDown);
  const padDown = slotsFn => e => { e.preventDefault(); localPress(slotsFn()); };
  el.padA.addEventListener('pointerdown', padDown(() => mode === 'local2p' ? [0, 1] : slotsFor('both')));
  el.padB.addEventListener('pointerdown', padDown(() => [2, 3]));
  el.mute.addEventListener('click', () => { Snd.unlock(); Snd.setMuted(!Snd.muted); syncMute(); });
  el.pads.hidden = !(touchUI && (mode === 'practice' || mode === 'host' || mode === 'guest' || mode === 'player' || mode === 'local2p'));
  el.padB.hidden = mode !== 'local2p';
  if (localTeam === 1) el.padA.style.marginLeft = 'auto';     // a right-hand player's pad
  if (mode === 'local2p') { el.padA.textContent = players[0].name; el.padB.textContent = players[1].name; }

  /* ============================ size, loop ============================ */
  function resize() {
    const w = el.stage.clientWidth, h = el.stage.clientHeight;
    if (!w || !h) return;
    const scale = Math.min(w / WW, h / WH);
    const cw = Math.floor(WW * scale), ch = Math.floor(WH * scale);
    el.frame.style.width = cw + 'px'; el.frame.style.height = ch + 'px';
    el.frame.style.setProperty('--u', (ch / WH).toFixed(4) + 'px');
    const dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr || 2);
    canvas.width = Math.max(1, Math.round(cw * dpr)); canvas.height = Math.max(1, Math.round(ch * dpr));
    K = canvas.width / WW;
    bgDirty = true;
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(el.stage); else window.addEventListener('resize', resize);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { bgDirty = true; });

  let raf = 0, last = 0, acc = 0, frameN = 0;
  const frameWork = [];
  function loop(now) {
    if (destroyed) return;
    const t0 = performance.now();
    const dt = last ? Math.min(0.1, (now - last) / 1000) : TICK;
    last = now;
    frameTimes.push(dt); if (frameTimes.length > 120) frameTimes.shift();
    if (SIM && !paused) {
      acc += dt;
      let n = 0;
      while (acc >= TICK && n < 5) { simTick(); acc -= TICK; n++; }
      if (n >= 5) acc = 0;
    }
    if (PRED) updatePredView(dt);
    else if (NET) updateNetView(dt);
    else { view = { R: sim.R, men: sim.chars, balls: sim.balls }; updateHud(sim.score, rules.capSec > 0 && sim.phase !== 'warmup' ? sim.clockRemain : -1, sim.golden); }
    if (botSkill && mode === 'guest' && !PRED) guestBot(dt);
    updateFx(dt);
    if (++frameN % renderEvery === 0) render();
    frameWork.push(performance.now() - t0); if (frameWork.length > 120) frameWork.shift();
    raf = requestAnimationFrame(loop);
  }
  // a CPU player for the guest side, working only from what it is shown
  let botT = 0;
  function guestBot(dt) {
    botT -= dt;
    if (botT > 0 || !view || !view.balls.length) return;
    botT = 0.05 + (1 - botSkill) * 0.2;
    for (const slot of [2, 3]) {
      const c = view.bySlot && view.bySlot[slot];
      if (!c || !c.seen) continue;
      const ball = nearestBallOf(view.balls.filter(b => b.seen), c);
      if (!ball) continue;
      const lean = angDiff(c.torso.angle, 0), leanF = lean * c.f;
      const dx = ball.position.x - c.torso.position.x, dxF = dx * c.f, adx = Math.abs(dx);
      const toward = (dx >= 0 ? 1 : -1) * lean;
      let want = 0;
      if (dxF > -25 && adx < 140 && leanF > 0.05) want = 0.85;
      else if (adx >= 140 && toward > 0.18 && dxF > -25) want = 0.5;
      if (want && Math.random() < want * botSkill) localPress([slot]);
    }
  }

  /* ============================ start ============================ */
  setPlayersHud();
  syncMute();
  if (SIM) {
    sim.resetRound({ roll: true, normal: true });
    if (mode === 'demo') sim.startDemo();
  }
  if (DIRECT) view = { R: sim.R, men: sim.chars, balls: sim.balls };
  resize();
  raf = requestAnimationFrame(loop);
  if (mode === 'practice' || mode === 'local2p') {
    hint(touchUI ? (mode === 'local2p' ? 'Tap your half of the pitch to jump and kick' : 'Tap anywhere to jump and kick')
      : (mode === 'local2p' ? players[0].name + ': W    ' + players[1].name + ': ↑' : 'Space, W or ↑ to jump and kick'));
  }
  let rttMs = null;
  const lastFrame = () => frames.length ? frames[frames.length - 1] : null;

  const api = {
    frame: el.frame,
    overlay: el.overlay,
    get mode() { return mode; },
    get team() { return localTeam; },
    get phase() { if (SIM) return sim.phase; if (pred && pred.hud) return pred.hud.phase; const f = lastFrame(); return f ? f.phase : 'warmup'; },
    get score() { if (SIM) return sim.score.slice(); if (pred && pred.hud) return pred.hud.score.slice(); const f = lastFrame(); return f ? f.score.slice() : [0, 0]; },
    get hostClock() { if (SIM) return sim.hostClock; if (pred && pred.latestTime >= 0) return pred.latestTime; const f = lastFrame(); return f ? f.t : 0; },
    get stats() { return sim ? sim.stats : null; },
    // here: begin the 3-2-1 countdown (practice, one device, the peer-to-peer host)
    startMatch(o) {
      Snd.unlock();
      if (!SIM) return;
      sim.startCountdown(o && o.score);
      if (mode === 'host') hint(touchUI ? 'Tap anywhere to jump and kick' : 'Space, W or ↑ to jump and kick. A/D for one player.');
    },
    // peer-to-peer host: the guest's presses, only ever for the right-hand team
    //   n, seq, leans, v: a predicting guest's press, for tick n (see sim.queuePress)
    //   vt: otherwise, the moment (host clock) of the picture the guest was looking at
    remotePress(slots, vt, n, seq, leans, v) {
      if (mode !== 'host') return;
      if (typeof n === 'number' && isFinite(n)) {
        const r = sim.queuePress(1, slots, n, seq, leans, v);
        if (hooks.onPressAck) hooks.onPressAck(seq, r.slack);
        return;
      }
      if (paused) return;
      for (const s of slots || []) if ((s === 2 || s === 3) && sim.bySlot[s]) sim.press(sim.bySlot[s], leanSeen(sim.bySlot[s], vt));
    },
    // from the authority: a snapshot frame, or for a predicting player a full state
    pushSnapshot(buf) {
      if (!NET || mode === 'host' || !buf || !buf.byteLength) return;
      if (new Uint8Array(buf, 0, 1)[0] === FULL_VERSION) {
        if (pred && pred.pushFullState(buf)) { lastFrameAt = performance.now(); haveFrame = true; noteFullState(); }
        return;
      }
      const f = decodeFrame(buf);
      if (f) { noteArrival(f); pushFrame(f); if (pred) pred.noteTime(f.t); }
    },
    applyRemoteEvent(ev) { if (NET && mode !== 'host' && ev && typeof ev.t === 'number') queueEvent(ev); },
    // the authority's word on a press (ticks it had to spare, below zero when late), and the
    // round trip, both for how far ahead the copy runs
    pressAck(seq, slack) { if (pred) pred.pressAck(seq, slack); },
    setRtt(ms) { if (typeof ms === 'number' && isFinite(ms) && ms > 0) { rttMs = ms; if (pred) pred.setRtt(ms); } },
    // the other player's press, as it happened (passed on by the match server, or the
    // peer-to-peer host's own)
    otherPress(slot, n, lean, rnd) { if (pred) pred.otherPress(slot, n, lean, rnd); },
    hostPress(slot, n, lean, rnd) { if (pred) pred.otherPress(slot, n, lean, rnd); },
    // peer-to-peer host: a guest (re)connected; it numbers its presses from its own start
    // peer-to-peer host: the guest (re)connected, so its presses are numbered from its own start
    resetGuest() { if (mode === 'host') sim.resetSeq(1); },
    // peer-to-peer host: a full state now, so a guest that came back during a pause (no ticks, so
    // no full states) has its copy going before play resumes
    sendFullState() { if (mode === 'host' && hooks.onFullState) hooks.onFullState(sim.captureState()); },
    get predicting() { return !!(pred && pred.on); },
    // peer-to-peer host: what a newly connected peer needs to start drawing
    getSync() {
      const roundEv = Object.assign(sim.roundEvent(), { t: sim.hostClock });
      return { k: 'sync', players, rules, round: roundEv, score: sim.score.slice(), phase: sim.phase, t: sim.hostClock };
    },
    applySync(s) {
      if (mode === 'host' || !s || !s.round) return;
      players = normPlayers(s.players);
      rules = Object.assign(rules, s.rules || {});
      kits = s.round.kits || resolveKits(players[0].color, players[1].color);
      setPlayersHud();
      frames = []; evq = []; playout = null; lastFxT = s.t - 0.001;
      if (pred) pred.reset();                    // the authority may have started over (a reload, a restart): its clock too
      setRound(s.round);
      showMods(s.round.mods);
      hud.score = [-1, -1];
      updateHud(s.score, null, null, -1);
    },
    setViewDelay(ms) { viewDelay = clamp(ms / 1000, 0, 0.4); },
    get viewDelay() { return effDelay() * 1000; },          // what this side actually waits (viewers: at least the floor)
    get lastFrameAge() { return haveFrame ? performance.now() - lastFrameAt : Infinity; },
    setInputDelay(n) { inputDelay = clamp(Math.round(n) || 0, 0, 8); if (pred) pred.inputDelay = inputDelay; },
    // a page with more than one pitch: draw less often (or not at all while hidden) and at
    // lower resolution, with sound on only the one being looked at
    setRenderEvery(n) { renderEvery = Math.max(1, Math.min(1e9, Math.round(n) || 1)); },
    setMaxDpr(n) { if (opts.maxDpr !== n) { opts.maxDpr = n; resize(); } },
    setSound(on) {
      const was = soundOn, now = api.phase;
      soundOn = !!on;
      if (soundOn) { Snd.unlock(); syncMute(); }
      if (was && !soundOn) Snd.crowdOff(); else if (!was && soundOn && (now === 'play' || now === 'goal')) Snd.crowdOn();
    },
    setPaused(v) {
      paused = !!v;
      if (sim) sim.setPaused(paused);             // presses from before a pause are dropped
      if (paused && Snd.ctx && Snd.ctx.state === 'running' && !NET) Snd.ctx.suspend(); else if (!paused && Snd.ctx) Snd.ctx.resume();
    },
    get paused() { return paused; },
    setInput(v) { inputOn = !!v; },
    setCpuSkill(v) { if (sim) sim.setCpuSkill(v); },
    setBot(skill) { botSkill = skill || 0; if (sim) sim.setBot(botSkill); if (pred) pred.bot = botSkill; },
    setPlayers(p) { players = normPlayers(p); kits = resolveKits(players[0].color, players[1].color); if (sim) sim.kits = kits; setPlayersHud(); },
    toast, banner, hint,
    // the network line: how the connection and this device are doing
    netStats() {
      const p95 = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
      const ps = pred ? pred.stats : null;
      return {
        rttMs: rttMs != null ? Math.round(rttMs) : null,
        frameMs: +p95(frameWork).toFixed(1),            // this device's work per frame (the copy and the drawing)
        frameGapMs: Math.round(p95(frameTimes) * 1000), // time between frames (above 17 ms: frames are being dropped)
        stallsPerMin: fullAt.gaps.length,               // full states that came more than 150 ms after the one before
        catchupsPerMin: pred ? pred.catchupsPerMin() : 0,
        late: ps ? ps.late : 0, resimMs: ps ? ps.costMs : 0, aheadMs: ps ? ps.aheadMs : 0,
        bufferMs: !PRED && NET && mode !== 'host' ? Math.round(effDelay() * 1000) : 0
      };
    },
    // tests
    debug: {
      get chars() { return sim ? sim.chars : pred ? pred.copy.chars : []; },
      get balls() { return sim ? sim.balls : pred ? pred.copy.balls : []; },
      get view() { return view; }, press: s => localPress(s), get frames() { return frames.length; },
      get net() { return { delayMs: Math.round(effDelay() * 1000), autoMs: Math.round(autoDelay * 1000), starved, lastRewind }; },
      get pred() { return pred ? pred.stats : null; },
      get lastGuestPress() { return sim ? sim.lastPress : []; },
      get pressLog() { return pred ? pred.lastPresses : []; },
      sim: o => sim ? sim.simulate(o) : null, hops: o => sim ? sim.hops(o) : null, replay: o => sim ? sim.replay(o) : null,
      tune: o => sim ? Object.assign(sim.tune, o) : null, get tuning() { return sim ? Object.assign({}, sim.tune) : {}; }
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
      clearTimeout(toastTimer); clearTimeout(bannerTimer); clearTimeout(hintTimer);
      if (soundOn) Snd.crowdOff();
      root.innerHTML = '';
    }
  };
  return api;
}

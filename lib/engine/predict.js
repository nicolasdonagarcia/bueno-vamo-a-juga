/* ------------------------------------------------------------------
   THE COTERIE CUP: a player's prediction
   No browser code: the match pages use it, and the match server's tests run it
   in Node against the real server.

   A player keeps their own copy of the match running a little ahead of the
   authority (the match server, or a peer-to-peer host): far enough that a press
   made now reaches the authority before it gets to that tick (the trip there plus
   a margin, less the cup's input delay). Their own men therefore react at once, and
   the authority applies the press on the same tick, so both matches agree. What the
   copy cannot know in time is the other player's presses: the authority passes each
   one on as it arrives, and each full state (20 a second) puts the copy back on the
   authority's state at that tick; either way the copy re-runs the ticks since, with
   this player's own presses still on their way. A jump of the other player's man
   that the copy heard of only once it was under way is then played from its start, a
   little faster than real until it has caught up, so it doesn't look like a leap
   (near the ball or this player's men, where he has to be where things meet him, he
   slides into place instead, as anything else does).

   createPredictor(o)
     o.team        0 (left) or 1 (right): whose men this player presses for
     o.inputDelay  ticks a press waits before it goes in (the same on every screen)
     o.players     for the copy's kits (they are not drawn)
     o.onFx(e)     a sound or spark to play now ({ type, x, y, v })
     o.hasRound(r) whether the page has the pictures for that round yet
     o.bot         tests: CPU skill for this player's men (they press through prediction)
     o.now()       seconds (performance.now by default)
   ------------------------------------------------------------------ */
import { TICK, PPM, angDiff, clamp } from './shared.js';
import { createSim, decodeState, teamOfSlot } from './sim.js';

const MAX_RESIM = 36;               // at most this many ticks re-run after a full state
const SMOOTH_T = 0.08;              // s: how fast a corrected picture slides into place
const SNAP_PX = 420;                // a jump bigger than this is a teleport (respawn, drop ball): no sliding
const CATCH_UP = 1.4;               // a revealed jump of the other player's man plays this much faster until it has caught up
const NEAR_BALL_PX = 170;           // a ball this close to him at his press is played out with him
const MINE_NEAR_PX = 170;           // ... as long as this player's men are no closer than this to it (or 120 to him):
const MINE_NEAR_MAN_PX = 120;       //     what this player can touch is always drawn as it is now
// The copy's own record of its last ticks, to hold a full state against: when the authority
// had at that tick what the copy had too (nobody did anything the copy could not know),
// there is nothing to put right and nothing to re-run. That is most of the time.
const HIST = 64, TOL_PX = 1.5, TOL_A = 0.02, TOL_V = 0.15;      // px; rad; m/s

export function createPredictor(o) {
  o = o || {};
  const team = o.team === 0 ? 0 : 1;
  const clock = o.now || (() => performance.now() / 1000);
  const hasRound = o.hasRound || (() => true);
  let inputDelay = clamp(Math.round(o.inputDelay || 0), 0, 8);
  let botSkill = o.bot || 0;
  const copy = createSim({ mode: 'copy', players: o.players, onFx: copyFx });
  const chars = copy.chars, bySlot = copy.bySlot, balls = copy.balls;       // the copy's own arrays, updated in place
  const mine = slot => teamOfSlot(slot) === team;

  let predOn = false, predRound = -1, predTick = 0, predK = 0, predResim = false, baseT = 0;
  let gT = null, latestHostT = -1, lastHostAt = 0, offMin = 0;
  const offs = [];
  let lastFS = null, fsNew = false, lastRecAt = 0, recEvery = 0.045, recCost = 0;
  let fsHist = [], baseAck = 0;          // the last full states (a re-run can start from an older one)
  let myPresses = [], pressSeq = 0, margin = 0.03, rttS = null;
  const fxLog = [];
  const offM = [], offB = [];      // what is drawn minus the copy: per slot 10 parts x (dx, dy, da), per ball (dx, dy, da)
  // The other player's presses as they happen ({ slot, n, lean, round }), and for each slot how many
  // ticks behind the copy that man is drawn: a jump the copy only heard of once it was under
  // way is played from its start, a little faster than real, until it has caught up.
  let otherPresses = [], opNew = false;
  const shiftL = [], shiftB = [];     // by man slot / by ball: ticks behind the copy, 0 = drawn as it is now
  let fxLater = [];                   // sounds of what is being played out, for when it is drawn
  let newFx = null;
  let hud = null;                     // the latest full state's score and clock
  const catchups = [];                // when a re-run moved something on screen (for the network line)
  const PS = { why: {}, reveals: 0, played: 0, slid: 0, slidWhy: {}, stopWhy: {}, reconciles: 0, recBy: { fs: 0, op: 0 }, same: 0, resim: 0, corr: [0, 0], corrN: [0, 0], corrMax: [0, 0], corrList: [[], []], late: 0, acks: 0, cost: 0, rebuilt: 0, slack: [], fullStates: 0 };
  const pressLog = [];                  // tests: the lean each of this player's presses went in with, first run
  const hist = [];

  function pctOf(a, p) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); }
  function reset() {
    predOn = false; predRound = -1; gT = null; latestHostT = -1; lastHostAt = 0; offs.length = 0;
    lastFS = null; fsNew = false; myPresses = []; fxLog.length = 0; hud = null;
    otherPresses = []; opNew = false; shiftL.length = 0; shiftB.length = 0; fxLater = []; fsHist = []; baseAck = 0;
  }
  // every frame or full state from the authority: when it was made (its clock) and when it got here
  function noteHostTime(t) {
    const now = clock();
    if (now - lastHostAt > 0.5) offs.length = 0;        // after a gap (pause, reconnect) measure afresh
    lastHostAt = now;
    if (t > latestHostT) latestHostT = t;
    offs.push(now - t);
    if (offs.length > 150) offs.shift();
    let mn = Infinity;
    for (const x of offs) if (x < mn) mn = x;
    offMin = mn;
  }
  // the authority's clock at which a press made now reaches it: its clock now (from the
  // quickest frames, which left a one-way trip ago) plus a round trip, plus a margin; with an
  // input delay a press waits that many ticks anyway, so the copy runs that much less ahead
  // But never behind the authority's own clock now (its latest full states would keep pulling
  // the copy forward): a player near the server with an input delay simply runs level with it.
  function predTarget(now) {
    const rtt = rttS != null ? rttS : 0.12;
    return Math.max(now - offMin + rtt / 2 + 0.002, now - offMin + rtt + margin - inputDelay * TICK);
  }
  function predGoal(now) {
    if (gT == null) gT = predTarget(now);
    const cap = latestHostT + (rttS != null ? rttS : 0.12) + margin + 0.25;     // no news from the authority: hold
    return Math.floor(Math.min(gT, cap) / TICK + 1e-6);
  }
  function offOf(slot) { return offM[slot] || (offM[slot] = new Float32Array(30)); }
  function ballOff(i) { return offB[i] || (offB[i] = new Float32Array(3)); }
  function clearOffsets() { for (const x of offM) if (x) x.fill(0); for (const x of offB) if (x) x.fill(0); }

  function record(k) {
    const n = chars.length * 62 + balls.length * 6;
    let h = hist[k % HIST];
    if (!h || h.a.length !== n) h = hist[k % HIST] = { a: new Float32Array(n) };
    h.k = k; h.round = predRound; h.nb = balls.length; h.phase = copy.phase; h.slowT = copy.slowT;
    const a = h.a;
    let i = 0;
    for (const c of chars) {
      a[i++] = c.kickT; a[i++] = c.cd;
      for (const b of c.parts) { const p = b.getPosition(), v = b.getLinearVelocity(); a[i++] = p.x; a[i++] = p.y; a[i++] = b.getAngle(); a[i++] = v.x; a[i++] = v.y; a[i++] = b.getAngularVelocity(); }
    }
    for (const b of balls) { const p = b.getPosition(), v = b.getLinearVelocity(); a[i++] = p.x; a[i++] = p.y; a[i++] = angDiff(b.getAngle(), 0); a[i++] = v.x; a[i++] = v.y; a[i++] = b.getAngularVelocity(); }
  }
  function sameAsCopy(fs) {
    const why = r => { PS.why[r] = (PS.why[r] || 0) + 1; return false; };
    const h = hist[fs.tick % HIST];
    if (!h || h.k !== fs.tick) return why('gone');
    if (h.round !== fs.round || h.nb !== fs.balls.length || h.phase !== fs.phase || Math.abs(h.slowT - fs.slowT) > 0.02) return why('match');
    if (h.a.length !== fs.men.length * 62 + fs.balls.length * 6) return why('match');
    const a = h.a, tp = (TOL_PX / PPM) ** 2, tv = TOL_V * TOL_V;
    let i = 0;
    for (let mi = 0; mi < fs.men.length; mi++) {
      const ms = fs.men[mi];
      if (!chars[mi] || chars[mi].slot !== ms.slot) return why('match');
      // a press the copy did not know about shows in the timers first
      if (Math.abs(a[i] - ms.kickT) > 0.03 || Math.abs(a[i + 1] - ms.cd) > 0.03) return why(mine(ms.slot) ? 'ownPress' : 'press');
      i += 2;
      const q = ms.p;
      for (let k = 0; k < 60; k += 6, i += 6) {
        const dx = a[i] - q[k], dy = a[i + 1] - q[k + 1], dvx = a[i + 3] - q[k + 3], dvy = a[i + 4] - q[k + 4];
        if (dx * dx + dy * dy > tp) return why('pos');
        if (Math.abs(a[i + 2] - q[k + 2]) > TOL_A) return why('angle');
        if (dvx * dvx + dvy * dvy > tv) return why('speed');
      }
    }
    for (const fb of fs.balls) {
      const q = fb.p, dx = a[i] - q[0], dy = a[i + 1] - q[1], dvx = a[i + 3] - q[3], dvy = a[i + 4] - q[4];
      if (dx * dx + dy * dy > tp || Math.abs(angDiff(a[i + 2], q[2])) > 0.05 || dvx * dvx + dvy * dvy > tv) return why('ball');
      i += 6;
    }
    return true;
  }

  // a copy of the authority's round: same rules, men with the same sway
  function buildCopy(fs) {
    copy.buildCopy(fs);
    predRound = fs.round;
    clearOffsets();
    PS.rebuilt++;
  }
  // put the copy exactly where the authority was at that tick
  function restoreCopy(fs) {
    if (!copy.restoreCopy(fs)) for (const x of offB) if (x) x.fill(0);
  }
  // one tick of the copy; k is the tick it brings the copy to. This player's own presses go
  // in on the tick they were stamped with (with the lean they were sent with), or right after
  // the full state if that is later (the authority got them late and applied them on arrival)
  function copyTick(k, resim) {
    predK = k; predResim = resim;
    for (const p of myPresses) {
      if (p.seq <= baseAck || Math.max(p.n, baseT + 1) !== k) continue;
      p.slots.forEach((s, i) => {
        if (!bySlot[s]) return;
        if (!resim && pressLog.length < 400) pressLog.push({ seq: p.seq, slot: s, lean: +p.leans[i].toFixed(4), tick: k });
        copy.press(bySlot[s], p.leans[i]);
      });
    }
    for (const h of otherPresses) {
      if (h.n !== k || h.round !== predRound || !bySlot[h.slot]) continue;
      copy.press(bySlot[h.slot], h.lean);
      if (!h.done) { h.done = true; h.fresh = resim; }
    }
    copy.copyStep(TICK);
    predTick = k;
    record(k);
    // tests: a CPU plays this player's men, pressing through prediction like a person would
    if (botSkill && !resim) copy.botTick(TICK, team, botSkill, c => press([c.slot]));
  }
  // this player's presses already in a full state (the authority numbers what it has had; a
  // number above any this page has sent is from before a reload, from another page: ignore it)
  function ackOf(fs) { const a = fs.ack[team]; return a <= pressSeq ? a : 0; }
  // presses are kept until they are older than any full state a re-run could start from
  function dropOld() {
    const oldest = fsHist.length ? fsHist[0].tick : predTick;
    myPresses = myPresses.filter(p => p.n > oldest - 40);
    otherPresses = otherPresses.filter(h => h.round > predRound || (h.round === predRound && h.n > oldest - 5));
  }
  // the other player's press heard of (from the press itself or a full state)
  function addOther(slot, n, lean, rnd) {
    if (!(slot >= 0 && slot <= 3) || mine(slot) || !isFinite(n) || !isFinite(lean)) return;
    if (otherPresses.some(h => h.slot === slot && h.n === n && h.round === rnd)) return;
    otherPresses.push({ slot, n: Math.floor(n), lean: +lean, round: rnd | 0 });
    if (otherPresses.length > 40) otherPresses.shift();
    opNew = true;
  }
  // a man as the copy recorded him after tick tk (between two ticks for a fractional tk), in
  // px and rad like the bodies' mirrors; null when the record has moved on
  function poseAt(c, tk) {
    const mi = chars.indexOf(c), k0 = Math.floor(tk), h0 = hist[k0 % HIST];
    if (mi < 0 || !h0 || h0.k !== k0 || h0.round !== predRound || h0.a.length < (mi + 1) * 62) return null;
    const h1 = hist[(k0 + 1) % HIST], f = tk - k0;
    const b = h1 && h1.k === k0 + 1 && h1.round === predRound && h1.a.length === h0.a.length && f > 0 ? h1.a : null;
    const a = h0.a, out = new Float32Array(30);
    for (let k = 0, i = mi * 62 + 2; k < 10; k++, i += 6) {
      out[k * 3] = (b ? a[i] + (b[i] - a[i]) * f : a[i]) * PPM;
      out[k * 3 + 1] = (b ? a[i + 1] + (b[i + 1] - a[i + 1]) * f : a[i + 1]) * PPM;
      out[k * 3 + 2] = b ? a[i + 2] + angDiff(b[i + 2], a[i + 2]) * f : a[i + 2];
    }
    return out;
  }
  // where a man is drawn from: the copy, or for a revealed jump being played out, its record
  function basePose(c) {
    const L = shiftL[c.slot] || 0;
    if (L > 0) {
      const q = poseAt(c, predTick - L);
      if (q) return q;
      shiftL[c.slot] = 0;
    }
    const out = new Float32Array(30);
    for (let k = 0; k < 10; k++) { const b = c.parts[k]; out[k * 3] = b.position.x; out[k * 3 + 1] = b.position.y; out[k * 3 + 2] = b.angle; }
    return out;
  }
  // a ball as recorded after tick tk, or as it is now: [x, y, angle] in px and rad
  function ballPoseAt(i, tk) {
    const k0 = Math.floor(tk), h0 = hist[k0 % HIST], j = chars.length * 62 + i * 6;
    if (!h0 || h0.k !== k0 || h0.round !== predRound || h0.a.length < j + 6) return null;
    const h1 = hist[(k0 + 1) % HIST], f = tk - k0;
    const b = h1 && h1.k === k0 + 1 && h1.round === predRound && h1.a.length === h0.a.length && f > 0 ? h1.a : null, a = h0.a;
    return [(b ? a[j] + (b[j] - a[j]) * f : a[j]) * PPM, (b ? a[j + 1] + (b[j + 1] - a[j + 1]) * f : a[j + 1]) * PPM, b ? a[j + 2] + angDiff(b[j + 2], a[j + 2]) * f : a[j + 2]];
  }
  function baseBall(i) {
    const L = shiftB[i] || 0, b = balls[i];
    if (L > 0) {
      const q = ballPoseAt(i, predTick - L);
      if (q) return q;
      shiftB[i] = 0;
    }
    return [b.position.x, b.position.y, b.angle];
  }
  // one of this player's men (as he is now) within r px of a point
  function mineNear(x, y, r) {
    for (const c of chars) if (c.team === team && Math.hypot(c.torso.position.x - x, c.torso.position.y - y) < r) return true;
    return false;
  }
  // something being played out stops and slides into place instead (this player's men came near, say)
  function unshift(c) {
    if (!(shiftL[c.slot] > 0)) return;
    const from = basePose(c);
    shiftL[c.slot] = 0;
    const to = basePose(c), off = offOf(c.slot);
    for (let k = 0; k < 30; k++) off[k] += k % 3 === 2 ? angDiff(from[k], to[k]) : from[k] - to[k];
  }
  function unshiftBall(i) {
    if (!(shiftB[i] > 0)) return;
    const from = baseBall(i);
    shiftB[i] = 0;
    const to = baseBall(i), off = ballOff(i);
    off[0] += from[0] - to[0]; off[1] += from[1] - to[1]; off[2] += angDiff(from[2], to[2]);
  }
  // A press of the other player's the copy heard of once the man was already under way: play
  // his jump from its start, and any ball he was about to play with it, unless this player's
  // men are near enough to touch them (or the ball moved so much meanwhile that it would
  // visibly jump back): then he and the ball slide into place like anything else
  function playOut(h, shownB) {
    const c = bySlot[h.slot];
    if (!c) return false;
    const no = r => { PS.slidWhy[r] = (PS.slidWhy[r] || 0) + 1; return false; };
    const L = predTick - (h.n - 1), at = predTick - L, man = poseAt(c, h.n), was = poseAt(c, at);
    if (!man || !was) return no('record');
    if (mineNear(was[0], was[1], MINE_NEAR_MAN_PX) || mineNear(c.torso.position.x, c.torso.position.y, MINE_NEAR_MAN_PX)) return no('mineMan');
    const near = [];
    for (let i = 0; i < balls.length; i++) {
      const q = ballPoseAt(i, h.n);
      if (q && Math.hypot(q[0] - man[0], q[1] - man[1]) < NEAR_BALL_PX) near.push(i);
    }
    for (const i of near) {
      const q = ballPoseAt(i, at), b = balls[i], d = shownB && shownB[i];
      if (!q || !d || Math.hypot(d[0] - q[0], d[1] - q[1]) > 40) return no('ballMoved');
      if (mineNear(q[0], q[1], MINE_NEAR_PX) || mineNear(b.position.x, b.position.y, MINE_NEAR_PX)) return no('ballMine');
    }
    shiftL[h.slot] = Math.max(shiftL[h.slot] || 0, L);
    for (const i of near) shiftB[i] = Math.max(shiftB[i] || 0, L);
    return true;
  }
  // a full state came in (or a press of the other player's): back to the authority's tick,
  // then the ticks since, again, with the presses on their way and the other player's
  // presses heard of meanwhile
  function reconcile(fs, now) {
    const t0 = clock();
    if (fs === lastFS) fsNew = false;
    lastRecAt = now;
    const fresh = !copy.world || !predOn || predRound !== fs.round || chars.length !== fs.men.length || fs.men.some(mm => !bySlot[mm.slot]);
    // what is on screen now, to slide from
    const shown = fresh ? null : chars.map(c => {
      const off = offOf(c.slot), d = basePose(c);
      for (let k = 0; k < 30; k++) d[k] += off[k];
      return { slot: c.slot, d };
    });
    const shownB = fresh ? null : balls.map((b, i) => { const off = ballOff(i), d = baseBall(i); return [d[0] + off[0], d[1] + off[1], d[2] + off[2]]; });
    if (fresh) { buildCopy(fs); shiftL.length = 0; shiftB.length = 0; fxLater = []; }
    restoreCopy(fs);
    record(fs.tick);
    // the presses the authority had had by then are in its state
    baseAck = ackOf(fs);
    for (const h of otherPresses) if (h.round === fs.round && h.n <= fs.tick) h.done = true;
    dropOld();
    const T = fs.tick, goal = predGoal(now);
    let to = fresh ? goal : Math.max(predTick, T);
    if (goal - to > 6) to = goal;                       // fell behind (a slow moment): catch up here
    to = Math.max(T, Math.min(to, T + MAX_RESIM));
    baseT = T; predTick = T;
    newFx = [];
    while (predTick < to) copyTick(predTick + 1, true);
    const heard = newFx; newFx = null;
    predOn = true;
    // the other player's presses this run put in for the first time
    let moved = 0;
    for (const h of otherPresses) {
      if (!h.fresh) continue;
      h.fresh = false;
      if (fresh) continue;
      PS.reveals++; moved++;
      if (playOut(h, shownB)) PS.played++; else PS.slid++;
    }
    // sounds this run found that the first didn't have: now, or when what made them is drawn
    for (const e of heard) {
      let who = null;
      for (const c of chars) if (shiftL[c.slot] > 0 && Math.hypot(c.torso.position.x - e.x, c.torso.position.y - e.y) < 260) who = { slot: c.slot };
      balls.forEach((b, i) => { if (shiftB[i] > 0 && Math.hypot(b.position.x - e.x, b.position.y - e.y) < 260) who = { ball: i }; });
      if (who && e.k > predTick - (who.ball != null ? shiftB[who.ball] : shiftL[who.slot])) fxLater.push({ e, k: e.k, who });
      else playFx(e);
    }
    if (shown) {
      for (const sv of shown) {
        const c = bySlot[sv.slot];
        if (!c) continue;
        const off = offOf(sv.slot), d = basePose(c);
        for (let k = 0; k < 30; k++) off[k] = k % 3 === 2 ? angDiff(sv.d[k], d[k]) : sv.d[k] - d[k];
        const dist = Math.abs(off[0]) + Math.abs(off[1]), side = mine(c.slot) ? 1 : 0;
        if (dist > SNAP_PX) off.fill(0);
        else if (dist > 3) moved++;
        PS.corr[side] += dist; PS.corrN[side]++; PS.corrMax[side] = Math.max(PS.corrMax[side], dist);
        const L = PS.corrList[side]; L.push(dist); if (L.length > 400) L.shift();
      }
      shownB.forEach((d, i) => {
        if (!balls[i]) return;
        const off = ballOff(i), q = baseBall(i);
        off[0] = d[0] - q[0]; off[1] = d[1] - q[1]; off[2] = angDiff(d[2], q[2]);
        const dist = Math.abs(off[0]) + Math.abs(off[1]);
        if (dist > SNAP_PX) off.fill(0);
        else if (dist > 3) moved++;
      });
    }
    if (moved) { catchups.push(now); while (catchups.length && catchups[0] < now - 60) catchups.shift(); }
    PS.reconciles++; PS.resim += predTick - T;
    const ms = (clock() - t0) * 1000;
    recCost = recCost ? recCost * 0.8 + ms * 0.2 : ms;
    PS.cost = recCost;
    recEvery = recCost > 8 ? 0.14 : recCost > 4 ? 0.09 : 0.045;      // a slow device re-runs less often
  }
  // effects while the copy runs: played the first time a tick runs; on a re-run only
  // what the first run did not have (the other player's kick, mostly), a moment late
  function playFx(e) { if (o.onFx) o.onFx(e); }
  function copyFx(type, x, y, v) {
    if (predResim) {
      for (const l of fxLog) if (l.type === type && Math.abs(l.k - predK) <= 4 && Math.abs(l.x - x) < 60 && Math.abs(l.y - y) < 60) return;
    }
    if (newFx) newFx.push({ type, x, y, v, k: predK }); else playFx({ type, x, y, v });
    fxLog.push({ type, k: predK, x, y });
    while (fxLog.length && fxLog[0].k < predK - 120) fxLog.shift();
    if (fxLog.length > 200) fxLog.shift();
  }

  // ---- once per frame ----
  // the copy on to now (the authority's clock plus the lead)
  function advance(dt, now) {
    const target = predTarget(now);
    if (gT == null || Math.abs(target - gT) > 0.3) gT = target;
    else { gT += dt; gT += (target - gT) * Math.min(1, dt * 2); }
    const goal = predGoal(now);
    for (let n = 0; predTick < goal && n < 6; n++) copyTick(predTick + 1, false);
  }
  function update(dt) {
    const now = clock();
    // the copy on to now first, so a full state from a tick it was about to reach anyway (a
    // player close to the server runs only just ahead) is held against it, not taken as a correction
    const wasOn = predOn;
    if (wasOn) advance(dt, now);
    // presses of the other player's not in the copy yet: re-run from the last full state from
    // before them, so their jumps can be played from the start
    if (opNew) {
      opNew = false;
      const fresh = predOn ? otherPresses.filter(h => !h.done && h.round === predRound && h.n <= predTick) : [];
      if (fresh.length) {
        const first = Math.min(...fresh.map(h => h.n));
        let base = null;
        for (let i = fsHist.length - 1; i >= 0 && !base; i--) if (fsHist[i].round === predRound && fsHist[i].tick < first) base = fsHist[i];
        // (not when that is further back than a re-run goes: on a very slow line the press then
        // comes in with the next full state and the man slides, as before)
        if (base && hasRound(base.round) && predTick - base.tick <= MAX_RESIM) {
          PS.recBy.op++;
          reconcile(base, now);
          if (lastFS && lastFS !== base) lastFS.same = null;          // held against the copy again below
        }
      }
    }
    if (fsNew && lastFS && hasRound(lastFS.round)) {
      // what only the authority decides and the copy never works out: the dead-ball ring
      if (predRound === lastFS.round && balls.length === lastFS.balls.length) lastFS.balls.forEach((fb, i) => { balls[i].warn = fb.warn; });
      if (lastFS.same == null) lastFS.same = predOn && predRound === lastFS.round && predTick >= lastFS.tick && sameAsCopy(lastFS);
      if (lastFS.same) {
        fsNew = false; PS.same++;
        for (const h of otherPresses) if (h.round === lastFS.round && h.n <= lastFS.tick) h.done = true;
        dropOld();
      } else if (now - lastRecAt >= recEvery) { PS.recBy.fs++; reconcile(lastFS, now); }
    }
    if (!predOn) return false;
    if (!wasOn) advance(dt, now);
    // what is being played out catches up; it slides into place at once when this player's men
    // come near (the ball, or the man), or the man meets a ball that isn't being played out
    const stepT = (dt / TICK) * (CATCH_UP - 1);
    balls.forEach((b, i) => {
      if (!(shiftB[i] > 0)) return;
      const q = baseBall(i);
      if (mineNear(q[0], q[1], MINE_NEAR_PX) || mineNear(b.position.x, b.position.y, MINE_NEAR_PX)) {
        PS.stopWhy.ballMine = (PS.stopWhy.ballMine || 0) + 1;
        unshiftBall(i);
        for (const c of chars) if (shiftL[c.slot] > 0) { const d = basePose(c); if (Math.hypot(d[0] - q[0], d[1] - q[1]) < NEAR_BALL_PX) unshift(c); }
      } else shiftB[i] = Math.max(0, shiftB[i] - stepT);
    });
    for (const c of chars) {
      if (!(shiftL[c.slot] > 0)) continue;
      const d = basePose(c);
      const loose = balls.some((b, i) => !(shiftB[i] > 0) && (Math.hypot(b.position.x - d[0], b.position.y - d[1]) < NEAR_BALL_PX || Math.hypot(b.position.x - c.torso.position.x, b.position.y - c.torso.position.y) < NEAR_BALL_PX));
      if (loose || mineNear(d[0], d[1], MINE_NEAR_MAN_PX) || mineNear(c.torso.position.x, c.torso.position.y, MINE_NEAR_MAN_PX)) {
        const r = loose ? 'looseBall' : 'mineMan';
        PS.stopWhy[r] = (PS.stopWhy[r] || 0) + 1;
        unshift(c);
      }
      else shiftL[c.slot] = Math.max(0, shiftL[c.slot] - stepT);
    }
    // their sounds, as they are drawn
    if (fxLater.length) fxLater = fxLater.filter(x => {
      const L = x.who.ball != null ? shiftB[x.who.ball] || 0 : shiftL[x.who.slot] || 0;
      if (predTick - L >= x.k) { playFx(x.e); return false; }
      return true;
    });
    // what was put right slides into place: the offsets die away
    const f = Math.exp(-dt / SMOOTH_T);
    for (const x of offM) if (x) for (let k = 0; k < 30; k++) x[k] *= f;
    for (const x of offB) if (x) { x[0] *= f; x[1] *= f; x[2] *= f; }
    return true;
  }
  // copy -> what is drawn: the round's puppets (set.bySlot[slot].parts, set.balls), plus the
  // offsets (dying away in update); false when there is nothing to draw yet
  function frame(dt, set) {
    if (!predOn || !set) return false;
    for (const c of chars) {
      const p = set.bySlot[c.slot];
      if (!p) continue;
      const off = offOf(c.slot), d = basePose(c), L = shiftL[c.slot] || 0;
      for (let k = 0; k < 10; k++) {
        const dst = p.parts[k];
        dst.position.x = d[k * 3] + off[k * 3]; dst.position.y = d[k * 3 + 1] + off[k * 3 + 1];
        dst.angle = d[k * 3 + 2] + off[k * 3 + 2];
      }
      let kick = c.kickT;
      if (L > 0) { const h = hist[Math.floor(predTick - L) % HIST], mi = chars.indexOf(c); if (h && mi >= 0) kick = h.a[mi * 62]; }
      p.kickT = kick > 0 ? 1 : 0; p.airT = c.airT > 0.25 ? 1 : 0;
      p.mood = c.moodT > 0 ? c.mood : 0; p.moodT = c.moodT > 0 ? 1 : 0;
      p.seen = true;
    }
    for (let i = 0; i < set.balls.length; i++) {
      const pb = set.balls[i], b = balls[i];
      if (!b) { pb.seen = false; continue; }
      const off = ballOff(i), q = baseBall(i);
      const nx = q[0] + off[0], ny = q[1] + off[1];
      pb.velocity.x = pb.seen ? nx - pb.position.x : 0; pb.velocity.y = pb.seen ? ny - pb.position.y : 0;
      pb.position.x = nx; pb.position.y = ny; pb.angle = q[2] + off[2];
      pb.dropT = b.dropT; pb.warn = b.warn;
      pb.seen = true;
    }
    return true;
  }
  // a press of this player's: it goes in on the copy's next tick (or a few later with an input
  // delay), with the lean his man has now, and the authority applies it on that same tick.
  // Returns what to send ({ seq, n, slots, leans, v }), or null before the first full state.
  function press(slots) {
    if (!predOn) return null;
    const ss = slots.filter(s => mine(s) && bySlot[s]);
    if (!ss.length) return null;
    const p = { seq: ++pressSeq, n: predTick + 1 + inputDelay, v: predTick, slots: ss, leans: ss.map(s => angDiff(bySlot[s].torso.getAngle(), 0)) };
    myPresses.push(p);
    if (myPresses.length > 30) myPresses.shift();
    if (o.onPress) o.onPress(p);
    return p;
  }

  return {
    get team() { return team; },
    get on() { return predOn; },
    get tick() { return predTick; },
    get round() { return predRound; },
    get phase() { return copy.phase; },
    get hud() { return hud; },
    get latestTime() { return latestHostT; },
    get copy() { return copy; },
    get inputDelay() { return inputDelay; },
    set inputDelay(v) { inputDelay = clamp(Math.round(v) || 0, 0, 8); },
    set bot(v) { botSkill = v || 0; },
    noteTime: noteHostTime,
    // a full state from the authority (binary); false if it wasn't one
    pushFullState(buf) {
      const s = decodeState(buf);
      if (!s) return false;
      PS.fullStates++;
      noteHostTime(s.t);
      if (!lastFS || s.t > lastFS.t) { lastFS = s; fsNew = true; hud = { score: s.score, clock: s.clock, golden: s.golden, phase: s.phase, t: s.t, over: s.over, winner: s.winner }; }
      if (!fsHist.length || s.t > fsHist[fsHist.length - 1].t) { fsHist.push(s); if (fsHist.length > 8) fsHist.shift(); }
      for (const q of s.presses) addOther(q.slot, q.n, q.lean, s.round);
      return true;
    },
    // the other player's press, passed on by the authority as it arrived
    otherPress(slot, n, lean, rnd) { addOther(slot, n, lean, rnd); },
    // the authority's word on a press (ticks it had to spare, below zero when late), and the
    // round trip, both for how far ahead the copy runs
    pressAck(seq, slack) {
      PS.acks++;
      if (typeof slack !== 'number' || !isFinite(slack)) return;
      if (slack < 0) PS.late++;
      PS.slack.push(slack); if (PS.slack.length > 30) PS.slack.shift();
      // aim for presses that reach the authority about 2 ticks early: a late one moves the copy
      // further ahead at once, a comfortable one brings it back a little at a time
      const err = slack - 2;
      margin = clamp(margin - err * TICK * (err < 0 ? 0.6 : 0.25), -0.1, 0.25);
    },
    setRtt(ms) { if (typeof ms === 'number' && isFinite(ms) && ms > 0) rttS = Math.min(1, ms / 1000); },
    press, update, frame, reset,
    catchupsPerMin() { const now = clock(); while (catchups.length && catchups[0] < now - 60) catchups.shift(); return catchups.length; },
    get lastPresses() { return pressLog; },
    get stats() {
      return { on: predOn, tick: predTick, round: predRound, team, inputDelay, aheadMs: Math.round((predTick * TICK - latestHostT) * 1000), marginMs: Math.round(margin * 1000),
        rttMs: rttS != null ? Math.round(rttS * 1000) : null, reconciles: PS.reconciles, recBy: PS.recBy, same: PS.same, resimAvg: PS.reconciles ? +(PS.resim / PS.reconciles).toFixed(1) : 0,
        slack: PS.slack.slice(-12), why: PS.why, fullStates: PS.fullStates,
        // the other player's presses heard of after the copy had passed them: played out from the start, or slid (ball near)
        reveals: PS.reveals, played: PS.played, slid: PS.slid, slidWhy: PS.slidWhy, stopWhy: PS.stopWhy,
        // how far the torsos had to move at a re-run, px: this player's own men, the other player's
        ownCorrAvgPx: PS.corrN[1] ? +(PS.corr[1] / PS.corrN[1]).toFixed(1) : 0, ownCorrMaxPx: Math.round(PS.corrMax[1]),
        ownCorrP50: pctOf(PS.corrList[1], 0.5), ownCorrP90: pctOf(PS.corrList[1], 0.9), oppCorrP50: pctOf(PS.corrList[0], 0.5), oppCorrP90: pctOf(PS.corrList[0], 0.9),
        oppCorrAvgPx: PS.corrN[0] ? +(PS.corr[0] / PS.corrN[0]).toFixed(1) : 0, oppCorrMaxPx: Math.round(PS.corrMax[0]),
        late: PS.late, acks: PS.acks, catchupsPerMin: catchups.length,
        costMs: +PS.cost.toFixed(2), rebuilt: PS.rebuilt, pending: myPresses.length };
    }
  };
}

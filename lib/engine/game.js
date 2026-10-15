/* ------------------------------------------------------------------
   THE COTERIE CUP: match engine
   One-button ragdoll football on planck.js (Box2D): metres, y down,
   80 px per metre. createGame(root, opts) builds a pitch inside `root`.

   modes
     practice   you (left) against the CPU, simulated here
     local2p    two people on one keyboard, simulated here
     demo       CPU against CPU, for backgrounds
     host       online: simulated here, guest presses arrive over the network,
                and every tick is recorded so both players watch the same
                slightly delayed replay (equal reaction time for both)
     guest      online: draws the host's snapshots, sends presses
     spectator  online: draws the host's snapshots
   ------------------------------------------------------------------ */
import * as planck from 'planck';
import {
  TAU, WH, WW, GROUND_Y, GOAL_D, BASE_GOAL_H, BAR_T, CEIL_Y, DROP_Y, PPM, GRAV, TICK,
  HEAD_R, TORSO_W, TORSO_H, ARM_W, ARM_H, THIGH_W, THIGH_H, SHIN_W, SHIN_H, FOOT_W, FOOT_H,
  BALL_TYPES, lemonPoints, ballExtent, ballReach, clamp, angDiff, makeRng, shade, readable, resolveKits, encodeFrame, decodeFrame, FX, Snd
} from './shared.js';

const pl = planck;
const SUBSTEPS = 2, VEL_IT = 10, POS_IT = 5;
const CAT_WORLD = 1, CAT_MAN = 2, CAT_BALL = 4;
const HIP_FLEX = 2.1, HIP_EXT = 0.75, KNEE_MAX = 2.3;
const NECK_T = 16, ARM_T = 4, ANKLE_T = 14;
const BAL_KP = 150, BAL_KD = 26, BAL_MAX = 320;
const HIP_KP = 10, HIP_MAXW = 9, HIP_HOLD = 115;
const KNEE_KP = 10, KNEE_MAXW = 9, KNEE_HOLD = 80;
const HIP_FOLLOW = 0.3;
const KICK_T = 0.26, KICK_CD = 0.26;
const KICK_W = 16, KICK_TORQUE = 330, KNEE_KICK_W = 26, KNEE_KICK_TORQUE = 220, SUPPORT_W = 8;
const JUMP_V = 9.6, JUMP_X = 1.4, COYOTE = 0.09;
const AIR_KP = 0.06, GETUP_T = 0.5, GETUP_V = 5.6;
const ASSIST = 0.14;
const MAX_PART = 30, MAX_BALL = 32, MAX_SPIN = 36;
const STALL_R = 22, WARN_T = 2.5;   // a ball that stays within STALL_R px is "still"; the last WARN_T s show a ring
const GOAL_T = 2.6;
const OWN_T = 1.5;                  // s: if the scoring side touched the ball this recently, it is their goal, not an own goal
// where each man stands at kick-off; slots 0 and 3, nearest their own goals, are the keepers
const HOME = [0.19, 0.38, 0.62, 0.81];
const SKINS = ['#f6d3b8', '#ebb995', '#d39a6a', '#b07646', '#8a5532', '#62391f'];
const HAIRS = ['#1d1714', '#3a2619', '#6b4426', '#b9884d', '#e2bf73', '#a8432a', '#7d7f86'];
const HAIR_STYLES = ['crop', 'crop', 'buzz', 'puff', 'quiff', 'pony', 'bald'];
const BALL_NAME = { beach: 'Beach ball', rugby: 'Rugby ball', american: 'American football', baseball: 'Baseball', giant: 'Giant ball', tiny: 'Tiny ball', balloon: 'Balloon' };
const OUT_TEXT = {
  roof: 'The ball was stuck on the goal roof',
  dead: 'The ball stopped dead',
  lost: 'The ball left the pitch'
};
const OUTLINE = '#0b0e26', LW = 2.4;

function m(px) { return px / PPM; }
function V(x, y) { return pl.Vec2(x / PPM, y / PPM); }
function goalHFor(gs) { return BASE_GOAL_H * gs; }
function barUnderFor(gs) { return GROUND_Y - goalHFor(gs); }
function teamOfSlot(slot) { return slot <= 1 ? 0 : 1; }
function isKeeper(slot) { return slot === 0 || slot === 3; }
function palette(kit, look) {
  return {
    shirt: kit.shirt, shirtD: shade(kit.shirt, -0.3), alt: kit.alt,
    shorts: kit.shorts, shortsD: shade(kit.shorts, -0.3), socks: kit.socks, socksD: shade(kit.socks, -0.3),
    boots: kit.boots, bootsD: shade(kit.boots, -0.3), trim: kit.trim,
    gloves: kit.gloves || null, glovesD: kit.gloves ? shade(kit.gloves, -0.3) : null,
    skin: look.skin, skinD: shade(look.skin, -0.24), hair: look.hair
  };
}
function baseRound() {
  return { goalScale: 1, gravity: 1, slippery: false, bouncy: false, ball: 'normal', twoBalls: false,
    bigHeads: false, longLegs: false };
}
function modsOf(R) {
  const out = [];
  if (R.goalScale > 1) out.push('Big goals'); else if (R.goalScale < 1) out.push('Small goals');
  if (R.gravity < 1) out.push('Moon gravity'); else if (R.gravity > 1) out.push('Heavy gravity');
  if (R.slippery) out.push('Ice pitch');
  if (R.bouncy) out.push('Bouncy pitch');
  if (BALL_NAME[R.ball]) out.push(BALL_NAME[R.ball]);
  if (R.twoBalls) out.push('Two balls');
  if (R.bigHeads) out.push('Big heads');
  if (R.longLegs) out.push('Long legs');
  return out;
}
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
  const NET = mode === 'host' || mode === 'guest' || mode === 'spectator';
  const SIM = mode === 'practice' || mode === 'local2p' || mode === 'demo' || mode === 'host';
  const DIRECT = SIM && !NET;                  // draw straight from the physics bodies
  const hooks = opts.hooks || {};
  const localTeam = mode === 'guest' ? 1 : (mode === 'spectator' || mode === 'demo') ? -1 : 0;
  let renderEvery = Math.max(1, opts.renderEvery || 1);
  let players = normPlayers(opts.players);
  let rules = Object.assign({ goals: 5, capSec: 0, modifiers: true }, opts.rules || {});
  let cpuSkill = opts.cpuSkill != null ? opts.cpuSkill : 0.74;
  let botSkill = opts.bot ? (opts.bot.skill || 0.7) : 0;
  let rng = opts.seed != null ? makeRng(opts.seed) : Math.random;
  let kits = resolveKits(players[0].color, players[1].color);
  const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let destroyed = false, paused = false, inputOn = opts.input !== false;
  // this pitch's sounds; a grid of matches keeps all but one quiet (setSound)
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

  /* ============================ simulation ============================ */
  let world = null, S = {};
  let chars = [], bySlot = [], balls = [], pending = [];
  let R = baseRound();
  let looks = [];
  let round = 0, score = [0, 0], phase = 'warmup', phaseT = 0, slowT = 0;
  let hostClock = 0, simTime = 0, clockRemain = -1, golden = false, matchOver = false, winner = -1, lastScorer = 0;
  let countN = 0, tickN = 0;
  // feel of the men; tests can override through debug.tune
  //   rock*       how far (rad) and how fast (rad/s) each man sways: a press at the
  //               peak of the sway sends him furthest forward or back
  //   keeperJump  the keeper's upward kick on a jump; keeperReach trims his
  //               sideways push so he jumps higher, not further
  //   deadT       seconds a ball can lie still before it is dropped again; the
  //               clock runs at nearRate while a man is right next to it, so a
  //               player on his way can still save it
  //   roofT       seconds a ball can sit on a goal roof before it is dropped again
  //               (a keeper's jump can just about head it off)
  const TUNE = { rockMin: 0.42, rockMax: 0.62, rockWMin: 1.6, rockWMax: 3.2, keeperJump: 1.25, keeperReach: 0.82,
    deadT: 7, nearRate: 0.5, roofT: 2.5 };
  let simSkills = null, M = null, forceR = null;          // debug.sim: CPU on both sides, metrics, forced round
  let testSlots = null, testX = null;                     // debug.hops: one man alone at one spot
  const stats = { respawns: 0, out: { roof: 0, dead: 0, lost: 0 } };
  let tickFx = [], netFx = [];
  let bodySeq = 0, groupSeq = 0;

  function newLooks() {
    for (let s = 0; s < 6; s++) looks[s] = { skin: pick(SKINS), hair: pick(HAIRS), style: pick(HAIR_STYLES) };
  }
  function rand(a, b) { return a + rng() * (b - a); }
  function pick(arr) { return arr[(rng() * arr.length) | 0]; }
  function chance(p) { return rng() < p; }
  function vrand(a, b) { return a + Math.random() * (b - a); }

  function tagBody(b, kind, part, owner) {
    b.kind = kind; b.part = part; b.owner = owner || null; b.uid = ++bodySeq;
    b.position = { x: 0, y: 0 }; b.velocity = { x: 0, y: 0 }; b.angle = 0;
    mirror(b);
    return b;
  }
  function mirror(b) {
    const p = b.getPosition(), v = b.getLinearVelocity();
    b.position.x = p.x * PPM; b.position.y = p.y * PPM;
    b.velocity.x = v.x * PPM / 60; b.velocity.y = v.y * PPM / 60;
    b.angle = b.getAngle();
  }
  function addV(b, vx, vy) { const v = b.getLinearVelocity(); b.setLinearVelocity(pl.Vec2(v.x + vx, v.y + vy)); }
  function box(b, w, h, o, ox, oy) {
    const shape = (ox || oy) ? pl.Box(m(w) / 2, m(h) / 2, V(ox || 0, oy || 0), 0) : pl.Box(m(w) / 2, m(h) / 2);
    return b.createFixture(shape, o);
  }
  function worldFix(fric, rest, tag) { return { density: 0, friction: fric, restitution: rest, filterCategoryBits: CAT_WORLD, userData: tag || null }; }
  function barUnderY() { return barUnderFor(R.goalScale); }
  function barTopY() { return barUnderY() - BAR_T; }

  function buildWorld() {
    world = pl.World({ gravity: pl.Vec2(0, GRAV * R.gravity), allowSleep: false });
    world.on('begin-contact', onBegin);
    world.on('end-contact', onEnd);
    world.on('pre-solve', onPreSolve);
    const g = world.createBody({ type: 'static', position: V(WW / 2, GROUND_Y + 300) });
    box(g, WW * 4, 600, worldFix(R.slippery ? 0.03 : 0.9, R.bouncy ? 0.92 : 0.1, 'turf'));
    S.ground = tagBody(g, 'world', 'ground');
    S.wallL = makeWall(-1); S.wallR = makeWall(1);
    const ce = world.createBody({ type: 'static', position: V(WW / 2, CEIL_Y - 100) });
    box(ce, WW * 4, 200, worldFix(0.2, 0.3));
    S.ceil = tagBody(ce, 'ceil', 'ceil');
    S.barL = makeBar(-1); S.barR = makeBar(1);
  }
  // behind each goal: below the bar the wall is the back of the net and soaks
  // the ball up; above it, a hard boundary at the edge of the screen
  function makeWall(side) {
    const b = world.createBody({ type: 'static', position: V(side < 0 ? -100 : WW + 100, 0) });
    const under = barUnderY(), bottom = GROUND_Y + 200, top = CEIL_Y - 300;
    box(b, 200, bottom - under, worldFix(0.85, 0.06, 'net'), 0, (under + bottom) / 2);
    box(b, 200, under - top, worldFix(0.3, 0.45, 'wall'), 0, (top + under) / 2);
    return tagBody(b, 'world', 'wall');
  }
  // crossbar + roof from the wall to the goal line, with a round end
  function makeBar(side) {
    const b = world.createBody({ type: 'static', position: V(side < 0 ? 0 : WW, barUnderY() - BAR_T / 2) });
    const s = side < 0 ? 1 : -1, capX = GOAL_D - BAR_T / 2, o = worldFix(0.4, 0.5, 'bar');
    box(b, capX + 40, BAR_T, o, s * (capX - 40) / 2, 0);
    b.createFixture(pl.Circle(V(s * capX, 0), m(BAR_T / 2)), o);
    return tagBody(b, 'world', 'bar');
  }

  /* ---------------- players ---------------- */
  function makeMan(spec) {
    const f = spec.team === 0 ? 1 : -1;
    const hs = spec.hs || 1, ls = spec.ls || 1;
    const th = THIGH_H * ls, sh = SHIN_H * ls;
    const hipY = TORSO_H / 2 - 5, ankleY = hipY + th + sh - 2, sole = ankleY + FOOT_H - 1;
    const x = spec.x, ty = GROUND_Y - sole - 1 - (spec.lift || 0);
    const grp = --groupSeq;
    const c = {
      slot: spec.slot, team: spec.team, f, keeper: !!spec.keeper, spec,
      kit: spec.kit, look: spec.look, hs, ls, th, sh, standH: sole + 1, homeX: spec.homeX != null ? spec.homeX : x,
      rockAmp: spec.rockAmp, rockW: spec.rockW, phase: spec.phase,
      cd: 0, kickT: 0, pushT: 0, landT: 0, airT: 0, lyingT: 0, lowT: 0, getupT: 0, kickLeg: 0,
      feet: 0, touch: 0, ai: rand(0, 0.3), mood: 0, moodT: 0
    };
    const part = (px, py, name) => tagBody(world.createBody({ type: 'dynamic', position: V(x + px, ty + py), linearDamping: 0.1, angularDamping: 0.5 }), 'man', name, c);
    const fo = (den, fric) => ({ density: den, friction: fric, restitution: 0.04, filterGroupIndex: grp, filterCategoryBits: CAT_MAN });
    const neckY = -TORSO_H / 2, hr = HEAD_R * hs, shY = neckY + 8;
    c.torso = part(0, 0, 'torso'); box(c.torso, TORSO_W, TORSO_H, fo(30, 0.4));
    c.head = part(0, neckY - hr * 0.86, 'head'); c.head.createFixture(pl.Circle(m(hr)), fo(15 / hs, 0.4));
    c.armNear = part(0, shY + ARM_H / 2 - 4, 'arm'); box(c.armNear, ARM_W, ARM_H, fo(12, 0.4));
    c.armFar = part(0, shY + ARM_H / 2 - 4, 'arm'); box(c.armFar, ARM_W, ARM_H, fo(12, 0.4));
    c.legs = [];
    for (let i = 0; i < 2; i++) {
      const sx = (i === 0 ? 3 : -3) * f, L = { sx };
      L.thigh = part(sx, hipY + th / 2, 'thigh'); box(L.thigh, THIGH_W, th, fo(30, 0.6));
      L.shin = part(sx, hipY + th + sh / 2, 'shin'); box(L.shin, SHIN_W, sh, fo(26, 0.8));
      L.foot = part(sx + f * 6, ankleY + FOOT_H / 2 - 1, 'foot'); box(L.foot, FOOT_W, FOOT_H, fo(24, 0.95));
      c.legs.push(L);
    }
    const rev = (a, b, ax, ay, lo, hi, torque) => world.createJoint(pl.RevoluteJoint({
      enableLimit: true, lowerAngle: lo, upperAngle: hi, enableMotor: true, maxMotorTorque: torque, motorSpeed: 0
    }, a, b, V(x + ax, ty + ay)));
    c.neck = rev(c.torso, c.head, 0, neckY + 2, -0.45, 0.45, NECK_T);
    c.shNear = rev(c.torso, c.armNear, 0, shY, -3, 3, ARM_T);
    c.shFar = rev(c.torso, c.armFar, 0, shY, -3, 3, ARM_T);
    for (let i = 0; i < 2; i++) {
      const L = c.legs[i];
      // joint angle = child - parent; with y down a positive angle swings a hanging
      // limb toward -x, so "forward" is -f for the hip and the knee bends with +f
      L.hip = rev(c.torso, L.thigh, L.sx, hipY, f > 0 ? -HIP_FLEX : -HIP_EXT, f > 0 ? HIP_EXT : HIP_FLEX, HIP_HOLD);
      L.knee = rev(L.thigh, L.shin, L.sx, hipY + th, f > 0 ? -0.02 : -KNEE_MAX, f > 0 ? KNEE_MAX : 0.02, KNEE_HOLD);
      L.ankle = rev(L.shin, L.foot, L.sx, ankleY, -0.5, 0.5, ANKLE_T);
    }
    c.parts = [c.torso, c.head, c.armNear, c.armFar, c.legs[0].thigh, c.legs[0].shin, c.legs[0].foot, c.legs[1].thigh, c.legs[1].shin, c.legs[1].foot];
    c.pal = palette(c.kit, c.look);
    return c;
  }
  // whole-body balance: one angular acceleration shared by every part about the
  // common centre of mass; on the turf the feet pivot, so he rocks like an
  // inverted pendulum. The cap means a hard enough hit knocks him over.
  function balanceWhole(c, e, kp, kd) {
    const ps = c.parts;
    let M = 0, cx = 0, cy = 0, I = 0, L = 0, i, b, mi, p;
    for (i = 0; i < ps.length; i++) { b = ps[i]; mi = b.getMass(); p = b.getWorldCenter(); M += mi; cx += mi * p.x; cy += mi * p.y; }
    cx /= M; cy /= M;
    for (i = 0; i < ps.length; i++) {
      b = ps[i]; mi = b.getMass(); p = b.getWorldCenter();
      const v = b.getLinearVelocity(), rx = p.x - cx, ry = p.y - cy;
      I += b.getInertia() + mi * (rx * rx + ry * ry);
      L += b.getInertia() * b.getAngularVelocity() + mi * (rx * v.y - ry * v.x);
    }
    const alpha = clamp(I * (e * kp - (L / I) * kd), -BAL_MAX, BAL_MAX) / I;
    for (i = 0; i < ps.length; i++) {
      b = ps[i]; mi = b.getMass(); p = b.getWorldCenter();
      b.applyForce(pl.Vec2(-mi * alpha * (p.y - cy), mi * alpha * (p.x - cx)), p, true);
      b.applyTorque(b.getInertia() * alpha, true);
    }
  }
  function driveJoint(j, target, kp, maxW) {
    target = clamp(target, j.getLowerLimit() + 0.03, j.getUpperLimit() - 0.03);
    j.setMotorSpeed(clamp((target - j.getJointAngle()) * kp, -maxW, maxW));
  }
  function driveHip(c, L, flex, kp, maxW, torque) { L.hip.setMaxMotorTorque(torque); driveJoint(L.hip, -c.f * flex, kp, maxW); }
  function driveKnee(c, L, bend, kp, maxW, torque) { L.knee.setMaxMotorTorque(torque); driveJoint(L.knee, c.f * bend, kp, maxW); }
  function driveArm(c, j, flex) { driveJoint(j, -c.f * flex, 7, 9); }

  function updateMan(c, dt, t) {
    c.cd -= dt; c.kickT -= dt; c.pushT -= dt; c.landT -= dt; c.getupT -= dt; c.moodT -= dt;
    const torso = c.torso, a = torso.getAngle(), lean = angDiff(a, 0), leanF = lean * c.f;
    const standing = c.feet > 0;
    if (standing) {
      if (c.airT > 0.3) { c.landT = 0.16; if (c.airT > 0.5) emitFx(FX.LAND, c.legs[0].foot.position.x, GROUND_Y, 1); }
      c.airT = 0;
    } else c.airT += dt;
    const upright = Math.abs(lean) < 1.1;
    if (!upright && c.touch > 0) c.lyingT += dt; else c.lyingT = 0;
    // down on the turf: after a moment he scrambles up with a little hop
    const low = c.touch > 0 && GROUND_Y - torso.position.y < c.standH * 0.72;
    c.lowT = low ? c.lowT + dt : 0;
    if (c.lowT > GETUP_T && c.cd <= 0) {
      c.lowT = 0; c.getupT = 0.45; c.cd = 0.2;
      launch(c, rand(-0.6, 0.6), -GETUP_V * Math.sqrt(R.gravity));
    }
    const target = c.rockAmp * Math.sin(t * c.rockW + c.phase);
    let kp = BAL_KP, kd = BAL_KD;
    if (c.getupT > 0) kp *= 1.1;
    else if (!standing) { kp *= AIR_KP; kd *= 0.5; if (c.kickT > 0) kp *= 0.3; }
    balanceWhole(c, angDiff(target, a), kp, kd);

    const stance = standing && upright ? 1 : upright ? 0.5 : 0.22;
    for (let i = 0; i < 2; i++) {
      const L = c.legs[i];
      if (c.kickT > 0) {
        if (i === c.kickLeg) {
          driveHip(c, L, HIP_FLEX - 0.2, 40, KICK_W, KICK_TORQUE);
          driveKnee(c, L, 0.04, 40, KNEE_KICK_W, KNEE_KICK_TORQUE);
        } else {
          driveHip(c, L, -0.4, 30, SUPPORT_W, KICK_TORQUE * 0.3);
          driveKnee(c, L, 0.3, 20, 12, KNEE_HOLD * 1.4);
        }
      } else if (c.pushT > 0) {
        driveHip(c, L, leanF * 0.9, HIP_KP, HIP_MAXW, HIP_HOLD * 1.6);
        driveKnee(c, L, 0.02, KNEE_KP * 2, KNEE_MAXW * 2, KNEE_HOLD * 2.2);
      } else {
        const land = c.landT > 0 ? 1 : 0;
        driveHip(c, L, leanF * HIP_FOLLOW + (i === 0 ? 0.09 : -0.09) + land * 0.3, HIP_KP, HIP_MAXW, HIP_HOLD * stance);
        driveKnee(c, L, 0.14 + land * 0.55, KNEE_KP, KNEE_MAXW, KNEE_HOLD * stance);
      }
      driveJoint(L.ankle, standing && upright ? angDiff(-L.shin.getAngle(), 0) : c.f * 0.1, 8, 6);
    }
    if (c.kickT > 0) {
      driveArm(c, c.shFar, c.kickLeg === 0 ? 1.4 : -0.8);
      driveArm(c, c.shNear, c.kickLeg === 0 ? -0.8 : 1.4);
    } else if (!standing && c.airT > 0.12) {
      driveArm(c, c.shNear, 2.2); driveArm(c, c.shFar, 2.6);
    } else {
      driveArm(c, c.shNear, 0.12 + leanF * 0.4); driveArm(c, c.shFar, -0.12 + leanF * 0.4);
    }
    driveJoint(c.neck, 0, 7, 6);
  }
  // One press: jump the way the body leans (if anything is under him) and swing a
  // kick toward the goal he attacks. In the air it is only the kick, which spins
  // the body: flips and overhead kicks come from there.
  function press(c) {
    if (!c || c.cd > 0 || phase === 'end' || phase === 'countdown') return false;
    c.cd = KICK_CD;
    const lean = angDiff(c.torso.getAngle(), 0);
    if (c.touch > 0 || c.airT < COYOTE) {
      const upright = Math.abs(lean) < 1.1;
      const a = upright ? clamp(lean, -1.1, 1.1) : clamp(lean, -0.5, 0.5);
      const jv = JUMP_V * (upright ? 1 : 0.85);
      launch(c, Math.sin(a) * jv * JUMP_X * (c.keeper ? TUNE.keeperReach : 1), -Math.cos(a) * jv * (c.keeper ? TUNE.keeperJump : 1));
      c.pushT = 0.1;
      emitFx(FX.HOP, c.torso.position.x, c.torso.position.y, 1);
    }
    c.kickT = KICK_T;
    c.kickLeg = 1 - c.kickLeg;
    return true;
  }
  function launch(c, vx, vy) {
    addV(c.torso, vx, vy); addV(c.head, vx, vy * 1.02);
    addV(c.armNear, vx * 0.9, vy * 0.85); addV(c.armFar, vx * 0.9, vy * 0.85);
    for (const L of c.legs) { addV(L.thigh, vx * 0.85, vy * 0.85); addV(L.shin, vx * 0.75, vy * 0.72); addV(L.foot, vx * 0.7, vy * 0.68); }
  }

  /* ---------------- balls ---------------- */
  function makeBall(x, y, type) {
    const t = BALL_TYPES[type] || BALL_TYPES.normal;
    const b = world.createBody({ type: 'dynamic', position: V(x, y), bullet: true, linearDamping: t.damp, angularDamping: t.adamp });
    const o = { density: t.den, friction: R.slippery ? 0.04 : t.fric, restitution: t.rest, filterCategoryBits: CAT_BALL };
    if (t.shape === 'capsule') {
      b.createFixture(pl.Box(m(t.half), m(t.r)), o);
      b.createFixture(pl.Circle(V(-t.half, 0), m(t.r)), o);
      b.createFixture(pl.Circle(V(t.half, 0), m(t.r)), o);
    } else if (t.shape === 'lemon') {
      b.createFixture(pl.Polygon(lemonPoints(t.half, t.r).map(([x, y]) => V(x, y))), o);
    } else b.createFixture(pl.Circle(m(t.r)), o);
    tagBody(b, 'ball', 'ball', null);
    b.ballType = type; b.ballR = t.r;
    b.anchorX = x; b.anchorY = y; b.stallT = 0; b.stillT = 0; b.roofT = 0; b.warn = 0;
    b.lastTeam = -1; b.touchT = [-1e9, -1e9]; b.trail = []; b.dropT = 0.7; b.lastSnd = 0; b.assistT = {};
    balls.push(b);
    return b;
  }
  function extX(b) { return ballExtent(b.ballType, b.ballR, b.angle).x; }
  function extY(b) { return ballExtent(b.ballType, b.ballR, b.angle).y; }

  /* ---------------- contacts ---------------- */
  function onBegin(contact) {
    const fa = contact.getFixtureA(), fb = contact.getFixtureB(), a = fa.getBody(), b = fb.getBody();
    countSupport(a, b, 1); countSupport(b, a, 1);
    if (a.kind === 'ball') ballContact(a, b, fb); else if (b.kind === 'ball') ballContact(b, a, fa);
  }
  function onEnd(contact) {
    const a = contact.getFixtureA().getBody(), b = contact.getFixtureB().getBody();
    countSupport(a, b, -1); countSupport(b, a, -1);
  }
  function countSupport(b, other, d) {
    if (b.kind !== 'man') return;
    if (!(other.kind === 'world' || (other.kind === 'man' && other.owner !== b.owner))) return;
    const c = b.owner;
    c.touch = Math.max(0, c.touch + d);
    if (b.part === 'foot' || b.part === 'shin') c.feet = Math.max(0, c.feet + d);
  }
  function onPreSolve(contact) {
    const fa = contact.getFixtureA(), fb = contact.getFixtureB();
    if (fa.getUserData() === 'net' || fb.getUserData() === 'net') { contact.setRestitution(0.05); contact.setFriction(0.9); }
  }
  function ballContact(ball, other, otherFix) {
    if (other.kind === 'man') {
      ball.lastTeam = other.owner.team; ball.lastKeeper = other.owner.keeper; ball.touchT[other.owner.team] = simTime;
      queueAssist(ball, other, other.owner); return;
    }
    const sp = Math.abs(ball.velocity.x) + Math.abs(ball.velocity.y);
    if (sp > 3 && simTime - ball.lastSnd > 0.07) {
      ball.lastSnd = simTime;
      const tag = otherFix.getUserData();
      emitFx(tag === 'bar' ? FX.POST : tag === 'net' ? FX.NET : FX.BOUNCE, ball.position.x, ball.position.y, sp);
    }
  }
  function queueAssist(ball, limb, c) {
    const last = ball.assistT[c.slot];
    if (last != null && simTime - last < 0.09) return;
    const bp = ball.getPosition(), lp = limb.getWorldCenter();
    let nx = bp.x - lp.x, ny = bp.y - lp.y;
    const d = Math.sqrt(nx * nx + ny * ny) || 1e-6;
    nx /= d; ny /= d;
    const rr = extX(ball) / PPM;
    const lv = limb.getLinearVelocityFromWorldPoint(pl.Vec2(bp.x - nx * rr, bp.y - ny * rr));
    const closing = lv.x * nx + lv.y * ny;
    if (closing <= 1.2) return;
    let k = ASSIST * (limb.part === 'head' ? 0.75 : limb.part === 'arm' ? 0.3 : limb.part === 'torso' ? 0.45 : 1);
    if (c.kickT <= 0) k *= 0.55;
    ball.assistT[c.slot] = simTime;
    pending.push({ ball, nx, ny, dv: closing * k });
  }
  function applyPending() {
    for (const q of pending) {
      const b = q.ball, v = b.getLinearVelocity();
      b.setLinearVelocity(pl.Vec2(v.x + q.nx * q.dv, v.y + q.ny * q.dv));
      const px = q.dv * PPM / 60;
      if (px > 2.4) emitFx(FX.KICK, b.position.x - q.nx * b.ballR, b.position.y - q.ny * b.ballR, px);
    }
    pending.length = 0;
  }
  function clampBody(b, maxPx, maxSpin) {
    const v = b.getLinearVelocity(), lim = maxPx * 60 / PPM, sp = Math.sqrt(v.x * v.x + v.y * v.y);
    if (sp > lim) b.setLinearVelocity(pl.Vec2(v.x / sp * lim, v.y / sp * lim));
    const w = b.getAngularVelocity();
    if (w > maxSpin) b.setAngularVelocity(maxSpin); else if (w < -maxSpin) b.setAngularVelocity(-maxSpin);
  }
  function syncAll() {
    for (const c of chars) for (const p of c.parts) { clampBody(p, MAX_PART, MAX_SPIN); mirror(p); }
    for (const b of balls) { clampBody(b, MAX_BALL, 40); mirror(b); }
  }

  /* ---------------- rounds ---------------- */
  function rollRound(normal) {
    R = baseRound();
    if (!normal && rules.modifiers) {
      R.goalScale = pick([1, 1, 1, 1, 1, 1.25, 0.8]);
      R.gravity = pick([1, 1, 1, 1, 1, 0.62, 1.35]);
      R.slippery = chance(0.12);
      R.bouncy = !R.slippery && chance(0.1);
      R.ball = pick(['normal', 'normal', 'normal', 'normal', 'normal', 'beach', 'rugby', 'american', 'baseball', 'giant', 'tiny', 'balloon']);
      R.twoBalls = chance(0.1);
      R.bigHeads = chance(0.12);
      R.longLegs = chance(0.12);
    }
    if (opts.forceRound) Object.assign(R, opts.forceRound);
    if (forceR) Object.assign(R, forceR);
  }
  function spawnSpec(slot) {
    const keeper = isKeeper(slot), team = teamOfSlot(slot);
    return {
      slot, team, keeper, x: testX != null ? testX : WW * HOME[slot],
      kit: keeper ? (team === 0 ? kits.keepA : kits.keepB) : (team === 0 ? kits.a : kits.b),
      look: looks[slot], hs: R.bigHeads ? 1.42 : 1, ls: R.longLegs ? 1.4 : 1,
      rockAmp: rand(TUNE.rockMin, TUNE.rockMax), rockW: rand(TUNE.rockWMin, TUNE.rockWMax), phase: rand(0, TAU)
    };
  }
  function resetRound(o) {
    if (o && o.roll) rollRound(o.normal);
    chars.length = 0; bySlot.length = 0; balls.length = 0; pending.length = 0;
    buildWorld();
    const slots = testSlots || [0, 1, 2, 3];
    for (const s of slots) { const c = makeMan(spawnSpec(s)); chars.push(c); bySlot[s] = c; }
    if (o && o.ball) dropBalls();
    round++;
    const ev = { k: 'round', round, R: Object.assign({}, R), slots, looks: looks.slice(), kits, mods: modsOf(R) };
    if (DIRECT) showMods(ev.mods);
    else emitEvent(ev);
  }
  function dropBalls() {
    if (R.twoBalls) { makeBall(WW / 2 - 70, DROP_Y, R.ball); makeBall(WW / 2 + 70, DROP_Y - 50, R.ball); }
    else makeBall(WW / 2, DROP_Y, R.ball);
  }
  function respawn(c) {
    const idx = chars.indexOf(c);
    for (const p of c.parts) world.destroyBody(p);
    const n = makeMan(Object.assign({}, c.spec, { x: c.homeX, lift: 40 }));
    n.homeX = c.homeX;
    if (idx >= 0) chars[idx] = n;
    bySlot[c.slot] = n;
    stats.respawns++;
  }

  /* ---------------- rules ---------------- */
  // A ball that is stuck on a goal roof or lying dead is dropped again from the
  // sky. Until then anyone can still save it, and the last WARN_T seconds show
  // as a ring winding down round the ball (b.warn, 0..1, sent in snapshots).
  function checkBall(b, dt) {
    const p = b.position;
    if (!(isFinite(p.x) && isFinite(p.y)) || p.x < -40 || p.x > WW + 40 || p.y > GROUND_Y + 60 || p.y < CEIL_Y - 80) { outOfPlay(b, 'lost'); return; }
    const top = barTopY(), ey = extY(b);
    const onRoof = p.y < top && p.y > top - ey - 12 && (p.x < GOAL_D + 2 || p.x > WW - GOAL_D - 2) && Math.abs(b.velocity.y) < 2.5;
    if (M && !onRoof && b.roofT > 1.4) M.roofSaves++;          // would have been dropped under the old 1.4 s rule
    b.roofT = onRoof ? b.roofT + dt : 0;
    if (b.roofT > TUNE.roofT) { outOfPlay(b, 'roof'); return; }
    const dx = p.x - b.anchorX, dy = p.y - b.anchorY;
    if (dx * dx + dy * dy > STALL_R * STALL_R) {
      if (M && b.stillT > 4) M.deadSaves++;                    // would have been dropped under the old 4 s rule
      b.anchorX = p.x; b.anchorY = p.y; b.stallT = 0; b.stillT = 0;
    } else {
      b.stallT += dt * (manNear(b) ? TUNE.nearRate : 1);
      b.stillT += dt;
      if (M && b.stillT > 4) M.lateStill += dt;                // tests: time spent waiting past the old 4 s rule
    }
    if (b.stallT > TUNE.deadT) { outOfPlay(b, 'dead'); return; }
    b.warn = Math.max(warnOf(b.roofT, TUNE.roofT), warnOf(b.stallT, TUNE.deadT));
  }
  function warnOf(t, limit) {
    const w = Math.min(WARN_T, limit * 0.6);
    return t > limit - w ? Math.min(1, (t - (limit - w)) / w) : 0;
  }
  // is any man close enough to play the ball (a body part within about a stride)?
  function manNear(b) {
    const p = b.position, d = ballReach(b.ballType) + 50, d2 = d * d;
    for (const c of chars) for (const q of c.parts) {
      const dx = q.position.x - p.x, dy = q.position.y - p.y;
      if (dx * dx + dy * dy < d2) return true;
    }
    return false;
  }
  function outOfPlay(b, reason) {
    stats.out[reason]++;
    const p = b.position;
    emitEvent({ k: 'out', reason, x: isFinite(p.x) ? clamp(p.x, 0, WW) : WW / 2, y: isFinite(p.y) ? clamp(p.y, 0, GROUND_Y) : 300 });
    const x = WW / 2 + (balls.length > 1 ? (balls.indexOf(b) === 0 ? -70 : 70) : 0) + rand(-24, 24);
    b.setTransform(V(x, DROP_Y), 0);
    b.setLinearVelocity(pl.Vec2(0, 0));
    b.setAngularVelocity(rand(-2, 2));
    mirror(b);
    b.anchorX = x; b.anchorY = DROP_Y; b.stallT = 0; b.stillT = 0; b.roofT = 0; b.warn = 0; b.trail.length = 0; b.dropT = 0.7;
  }
  function checkMan(c) {
    const p = c.torso.position;
    let bad = !(isFinite(p.x) && isFinite(p.y)) || p.x < -60 || p.x > WW + 60 || p.y > GROUND_Y + 40 || p.y < CEIL_Y - 120;
    if (!bad) {
      const h = c.head.position, fp = c.legs[0].foot.position;
      bad = !(Math.abs(h.x - fp.x) + Math.abs(h.y - fp.y) < 400);
    }
    if (bad) respawn(c);
  }
  function checkGoal() {
    const under = barUnderY();
    for (const b of balls) {
      const p = b.position, ex = extX(b);
      if (p.y < under) continue;
      if (p.x + ex < GOAL_D) return scored(1, b, -1);
      if (p.x - ex > WW - GOAL_D) return scored(0, b, 1);
    }
  }
  function scored(team, ball, side) {
    score[team]++;
    lastScorer = team;
    // an own goal only when the other side put it in: a shot that brushes the keeper on its
    // way in is still the shooter's goal
    const own = ball.lastTeam === 1 - team && simTime - ball.touchT[team] > OWN_T;
    for (const c of chars) { c.mood = c.team === team ? 1 : -1; c.moodT = 3; }
    if (score[team] >= rules.goals || golden) { matchOver = true; winner = team; }
    phase = 'goal'; phaseT = 0;
    slowT = reduceMotion ? 0 : 0.9;
    if (M) { M.goals++; M.goalsBy[team]++; if (own) { M.own++; if (ball.lastKeeper) M.ownKeeper++; } }
    emitEvent({ k: 'goal', team, own, side, y: ball.position.y, score: score.slice(), over: matchOver });
    if (hooks.onScore) hooks.onScore(score.slice(), { team, own, over: matchOver });
  }
  function endMatch(w, reason) {
    matchOver = true; winner = w; phase = 'end'; phaseT = 0;
    emitEvent({ k: 'end', winner: w, score: score.slice(), reason });
    if (hooks.onEnd) hooks.onEnd({ winner: w, score: score.slice(), reason });
  }
  function startCountdown(from) {
    if (phase !== 'warmup') return;
    resetRound({ roll: true, normal: true });      // everybody back on their spot for a fair start
    phase = 'countdown'; phaseT = 0; countN = 0;
    clockRemain = rules.capSec > 0 ? rules.capSec : -1;
    golden = false; matchOver = false; winner = -1;
    // a match resumed after the host reloaded carries on from the score it had
    score = from && from.length === 2 ? [Math.max(0, from[0] | 0), Math.max(0, from[1] | 0)] : [0, 0];
  }
  // phase machine, once per tick of real time
  function flow(dt) {
    phaseT += dt;
    if (phase === 'countdown') {
      const n = Math.floor(phaseT);
      if (n > countN - 1 && countN < 3) { countN++; emitEvent({ k: 'count', n: 4 - countN }); }
      if (phaseT >= 3) {
        phase = 'play'; phaseT = 0;
        dropBalls();
        emitEvent({ k: 'kickoff' });
      }
    } else if (phase === 'play') {
      if (clockRemain > 0) {
        clockRemain -= dt;
        if (clockRemain <= 0) {
          clockRemain = 0;
          if (score[0] !== score[1]) endMatch(score[0] > score[1] ? 0 : 1, 'time');
          else if (!golden) { golden = true; emitEvent({ k: 'golden' }); }
        }
      }
    } else if (phase === 'goal' && phaseT >= GOAL_T) {
      if (matchOver) { endMatch(winner, 'goals'); return; }
      resetRound({ roll: true, ball: true });
      phase = 'play'; phaseT = 0;
      emitEvent({ k: 'kickoff', silent: true });
    }
  }

  /* ---------------- CPU ---------------- */
  function nearestBallOf(list, c) {
    let best = null, bd = 1e9;
    const tp = c.torso.position;
    for (const b of list) {
      const dx = b.position.x - tp.x, dy = b.position.y - tp.y, d = dx * dx + dy * dy * 0.5;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }
  function predictMiss(c, ball) {
    const a = angDiff(c.torso.getAngle(), 0), tp = c.torso.position, g = GRAV * R.gravity * PPM;
    let vx, vy;
    if (c.touch > 0 || c.airT < COYOTE) {
      const ja = clamp(a, -1.1, 1.1);
      vx = Math.sin(ja) * JUMP_V * JUMP_X * PPM * (c.keeper ? TUNE.keeperReach : 1); vy = -Math.cos(ja) * JUMP_V * PPM * (c.keeper ? TUNE.keeperJump : 1);
    } else { vx = c.torso.velocity.x * 60; vy = c.torso.velocity.y * 60; }
    const hx = tp.x - Math.sin(a) * 18 + c.f * 30, hy = tp.y + Math.cos(a) * 18 + 26;
    const bx = ball.position.x, by = ball.position.y, bvx = ball.velocity.x * 60, bvy = ball.velocity.y * 60, floor = GROUND_Y - ball.ballR;
    let best = 1e9;
    for (let t = 0.06; t < 0.4; t += 0.06) {
      const fx = hx + vx * t, fy = Math.min(GROUND_Y - 6, hy + vy * t + 0.5 * g * t * t);
      const px = bx + bvx * t, py = Math.min(floor, by + bvy * t + 0.5 * g * t * t);
      best = Math.min(best, Math.hypot(fx - px, fy - py));
    }
    return best;
  }
  // same button a person has: skill is timing (reaction, waiting for the jump
  // to meet the ball, fewer mistimed presses)
  function aiMan(c, dt, skill) {
    c.ai -= dt;
    if (c.ai > 0 || c.cd > 0) return false;
    const ball = nearestBallOf(balls, c);
    if (!ball) return false;
    const react = 0.03 + (1 - skill) * 0.3;
    if (rng() < (1 - skill) * 0.08) { press(c); c.ai = react + 0.15; return true; }
    const tp = c.torso.position, bp = ball.position;
    const dx = bp.x - tp.x, dy = bp.y - tp.y, adx = Math.abs(dx), dxF = dx * c.f;
    const lean = angDiff(c.torso.getAngle(), 0), leanF = lean * c.f, toward = (dx >= 0 ? 1 : -1) * lean;
    const grounded = c.touch > 0, behind = dxF < -24;
    let want = 0;
    if (!grounded) {
      if (!behind && adx < 75 && Math.abs(dy) < 95) want = 0.8;
    } else if (behind) {
      const fromOwn = (c.f > 0 ? bp.x - GOAL_D : WW - GOAL_D - bp.x) / (WW - 2 * GOAL_D);
      if (adx > 170 && toward > 0.22) want = 0.45;
      else if (toward > 0.22) want = 0.08 + 0.32 * clamp(fromOwn, 0, 1) * (1.2 - skill);
    } else if (skill >= 0.7 && adx < 260 && dy > -260) {
      if (predictMiss(c, ball) < 30 + (1 - skill) * 120) want = 0.95;
      else if (adx >= 140 && toward > 0.24) want = 0.35;
    } else if (adx < 140 && dy > -190) {
      if (leanF > 0.04) want = 0.85;
    } else if (adx >= 140 && toward > 0.18) want = 0.55;
    if (grounded && !behind && adx < 80 && dy < -70 && dy > -280 && ball.velocity.y > 0) want = Math.max(want, 0.7);
    if (want > 0 && rng() < want * (0.45 + 0.55 * skill)) { press(c); c.ai = react + rand(0.08, 0.2); return true; }
    c.ai = react * rand(0.5, 1);
    return false;
  }
  function aiKeeper(c, dt, skill) {
    c.ai -= dt;
    if (c.ai > 0 || c.cd > 0) return;
    const ball = nearestBallOf(balls, c);
    if (!ball) return;
    const tp = c.torso.position, bp = ball.position, dx = bp.x - tp.x, adx = Math.abs(dx);
    const lean = angDiff(c.torso.getAngle(), 0);
    const danger = c.f > 0 ? bp.x < WW * 0.42 : bp.x > WW * 0.58;
    const incoming = c.f > 0 ? ball.velocity.x < -1.5 : ball.velocity.x > 1.5;
    let want = 0;
    if (danger && dx * c.f > -10 && adx < 190 && (incoming || adx < 90)) want = 0.75;
    else if (c.touch > 0 && Math.abs(tp.x - c.homeX) > 110 && (c.homeX > tp.x ? 1 : -1) * lean > 0.15) want = 0.5;
    if (want > 0 && rng() < want * skill) { press(c); c.ai = rand(0.16, 0.36); } else c.ai = rand(0.04, 0.1);
  }
  function controlAI(dt) {
    if (phase !== 'play' && phase !== 'goal') return;
    for (const c of chars) {
      let skill = 0;
      if (simSkills) skill = simSkills[c.team];
      else if (mode === 'demo') skill = 0.72;
      else if (mode === 'practice' && c.team === 1) skill = cpuSkill;
      else if (botSkill && c.team === 0 && (mode === 'practice' || mode === 'host')) skill = botSkill;
      if (skill <= 0) continue;
      if (c.keeper) aiKeeper(c, dt, skill); else aiMan(c, dt, skill);
    }
  }

  /* ---------------- stepping ---------------- */
  function step(dt) {
    if (dt <= 0) return;
    simTime += dt;
    controlAI(dt);
    const sub = dt / SUBSTEPS;
    for (let k = 0; k < SUBSTEPS; k++) {
      const t = simTime - dt + sub * (k + 1);
      for (const c of chars) updateMan(c, sub, t);
      world.step(sub, VEL_IT, POS_IT);
      applyPending();
      syncAll();
    }
    // the "just dropped" ring fades in simulated time, so a host's snapshots carry it for 0.7 s only
    for (const b of balls) if (b.dropT > 0) b.dropT -= dt;
    if (phase === 'play') {
      for (const b of balls) checkBall(b, dt);
      checkGoal();
    } else for (const b of balls) b.warn = 0;
    for (let i = 0; i < chars.length; i++) checkMan(chars[i]);
  }
  function simTick(dt) {
    hostClock += dt;
    let scale = 1;
    if (slowT > 0) { slowT -= dt; scale = 0.3; }
    step(dt * scale);
    flow(dt);
    if (mode === 'demo' && phase === 'end') restartDemo();
    if (NET) {
      const f = captureFrame();
      pushFrame(f);
      for (const e of tickFx) netFx.push(e);
      if (++tickN % 2 === 0 && hooks.onSnapshot) {
        f.fx = netFx;
        hooks.onSnapshot(encodeFrame(f));
        netFx = [];
      }
    }
    tickFx = [];
  }
  function restartDemo() {
    score = [0, 0]; matchOver = false; winner = -1; golden = false;
    resetRound({ roll: true, ball: true });
    phase = 'play'; phaseT = 0;
  }

  /* ============================ frames, timeline ============================ */
  // A frame is one moment of the match: every body's position and angle, the
  // score and clock, plus the cosmetic effects that happened during it.
  let frames = [];                 // ascending t
  let evq = [];                    // pending display events, ascending t
  let puppetSets = new Map();      // round -> puppets built from that round's description
  let view = null;                 // what is being drawn: { R, men, balls }
  let renderT = 0, lastFxT = -1, playout = null, viewDelay = 0.06, haveFrame = false;
  let hud = { score: [-1, -1], clock: -2, golden: null };
  let lastFrameAt = 0;

  function captureFrame() {
    const men = [];
    for (const c of chars) {
      const p = new Float32Array(30);
      for (let i = 0; i < 10; i++) { const b = c.parts[i]; p[i * 3] = b.position.x; p[i * 3 + 1] = b.position.y; p[i * 3 + 2] = b.angle; }
      const bits = (c.kickT > 0 ? 1 : 0) | (c.airT > 0.25 ? 2 : 0) | ((c.moodT > 0 ? c.mood + 1 : 1) << 2);
      men.push({ slot: c.slot, bits, p });
    }
    return {
      t: hostClock, phase, round, score: score.slice(), clock: clockRemain, golden,
      // ball bits: 1 = just dropped, bits 1-7 = how far the "about to be dropped again" ring has wound down
      men, balls: balls.map(b => ({ x: b.position.x, y: b.position.y, a: b.angle, bits: (b.dropT > 0 ? 1 : 0) | (Math.round(clamp(b.warn, 0, 1) * 127) << 1) })),
      fx: tickFx.slice()
    };
  }
  function pushFrame(f) {
    if (frames.length && f.t <= frames[frames.length - 1].t) return;
    frames.push(f);
    while (frames.length > 4 && frames[0].t < f.t - 3) frames.shift();
    haveFrame = true;
    lastFrameAt = performance.now();
  }
  function emitFx(type, x, y, v) {
    if (mode === 'demo' && !opts.demoSound) { if (type === FX.LAND) dust(x, y, 4); return; }
    if (DIRECT) playFx({ type, x, y, v });
    else tickFx.push({ type, x, y, v });
  }
  function emitEvent(ev) {
    ev.t = hostClock;
    if (DIRECT) { applyEvent(ev); return; }
    queueEvent(ev);
    if (hooks.onEvent) hooks.onEvent(ev);
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
    if (mode === 'host') renderT = hostClock - viewDelay;
    else {
      const target = newest - viewDelay;
      if (playout == null || Math.abs(playout - target) > 1) playout = target;
      playout += dt;
      playout += (target - playout) * Math.min(1, dt * 2);
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
        if (DIRECT) for (const c of chars) { c.mood = c.team === ev.team ? 1 : -1; c.moodT = 3; }
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
    const top = barUnderFor(view && view.R ? view.R.goalScale : R.goalScale) - BAR_T;
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
    // the pads sit outside the frame: colour them directly, the guest's pad in its own team colour
    el.padA.style.background = mode === 'guest' ? kits.hexB : kits.hexA;
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
    if (mode === 'guest') { if (hooks.onPress) hooks.onPress(slots); return; }
    if (!SIM) return;
    for (const s of slots) if (bySlot[s]) press(bySlot[s]);
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
  el.pads.hidden = !(touchUI && (mode === 'practice' || mode === 'host' || mode === 'guest' || mode === 'local2p'));
  el.padB.hidden = mode !== 'local2p';
  if (mode === 'guest') el.padA.style.marginLeft = 'auto';     // the guest plays the right-hand team
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
  function loop(now) {
    if (destroyed) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : TICK;
    last = now;
    if (SIM && !paused) {
      acc += dt;
      let n = 0;
      while (acc >= TICK && n < 5) { simTick(TICK); acc -= TICK; n++; }
      if (n >= 5) acc = 0;
    }
    if (NET) updateNetView(dt);
    else { view = { R, men: chars, balls }; updateHud(score, rules.capSec > 0 && phase !== 'warmup' ? clockRemain : -1, golden); }
    if (botSkill && (mode === 'guest')) guestBot(dt);
    updateFx(dt);
    if (++frameN % renderEvery === 0) render();
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

  /* ============================ test harness ============================ */
  // debug.sim plays CPU against CPU synchronously (no drawing) and measures how
  // the men move: jump heights, hop distances, falls, goals. Practice mode only.
  function simCollect() {
    if (phase !== 'play') return;
    M.playTicks++;
    for (const c of chars) {
      M.manTicks++;
      const tp = c.torso.position;
      if (Math.abs(angDiff(c.torso.getAngle(), 0)) > 1.1 && c.touch > 0) M.lying++;
      if (c.touch === 0) {
        M.air++;
        if (!c.simAir) c.simAir = { x: tp.x, y: tp.y, apex: tp.y, t: 0 };
        else { c.simAir.apex = Math.min(c.simAir.apex, tp.y); c.simAir.t += TICK; }
      } else if (c.simAir) {
        const a = c.simAir, k = c.keeper ? M.keeper : M.striker;
        c.simAir = null;
        if (a.t > 0.25) { k.apex.push(a.y - a.apex); k.hop.push((tp.x - a.x) * c.f); }
      }
    }
  }
  function simulate(o) {
    if (mode !== 'practice') return null;
    o = o || {};
    if (o.tune) Object.assign(TUNE, o.tune);
    rng = makeRng(o.seed != null ? o.seed : 1);
    simSkills = o.skills || [0.8, 0.8];
    forceR = o.force || null;
    const saved = rules;
    rules = Object.assign({}, rules, { goals: 1e6, capSec: 0, modifiers: !!o.modifiers });
    score = [0, 0]; matchOver = false; golden = false; winner = -1; stats.respawns = 0; stats.out = { roof: 0, dead: 0, lost: 0 };
    newLooks();
    resetRound({ roll: true, normal: !o.modifiers, ball: true });
    phase = 'play'; phaseT = 0; slowT = 0;
    M = { playTicks: 0, manTicks: 0, lying: 0, air: 0, goals: 0, own: 0, ownKeeper: 0, goalsBy: [0, 0], deadSaves: 0, roofSaves: 0, lateStill: 0, keeper: { apex: [], hop: [] }, striker: { apex: [], hop: [] } };
    const n = Math.round((o.seconds || 60) / TICK);
    for (let i = 0; i < n; i++) { simTick(TICK); simCollect(); }
    const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
    const absAll = a => a.map(Math.abs);
    const group = k => ({ jumps: k.apex.length, apexP50: pct(k.apex, 0.5), apexP90: pct(k.apex, 0.9), apexMax: pct(k.apex, 1),
      hopP50: pct(absAll(k.hop), 0.5), hopP90: pct(absAll(k.hop), 0.9), fwdShare: +(k.hop.filter(h => h > 20).length / (k.hop.length || 1)).toFixed(2),
      backShare: +(k.hop.filter(h => h < -20).length / (k.hop.length || 1)).toFixed(2) });
    const mins = M.playTicks * TICK / 60 || 1;
    const out = {
      goalsPerMin: +(M.goals / mins).toFixed(2), ownGoalsPerMin: +(M.own / mins).toFixed(2), score: score.slice(), goalsBy: M.goalsBy.slice(),
      ownByKeeperShare: M.own ? +(M.ownKeeper / M.own).toFixed(2) : 0,
      lying: +(M.lying / (M.manTicks || 1)).toFixed(3), airborne: +(M.air / (M.manTicks || 1)).toFixed(3),
      outsPerMin: +((stats.out.roof + stats.out.dead + stats.out.lost) / mins).toFixed(2), respawns: stats.respawns,
      deadPerMin: +(stats.out.dead / mins).toFixed(2), roofPerMin: +(stats.out.roof / mins).toFixed(2), lostPerMin: +(stats.out.lost / mins).toFixed(2),
      deadSavesPerMin: +(M.deadSaves / mins).toFixed(2), roofSavesPerMin: +(M.roofSaves / mins).toFixed(2),
      lateStillSecPerMin: +(M.lateStill / mins).toFixed(2),
      striker: group(M.striker), keeper: group(M.keeper)
    };
    M = null; simSkills = null; forceR = null; rules = saved; rng = Math.random;
    return out;
  }

  // debug.hops: every man presses once, at the peak of his lean toward `dir`
  // (1 forward, -1 back), like a player timing the swing. Measures the hop
  // distance (px, + = the way he leaned) and whether he is down a second later.
  function hopTest(o) {
    if (mode !== 'practice') return null;
    o = o || {};
    if (o.tune) Object.assign(TUNE, o.tune);
    rng = makeRng(o.seed != null ? o.seed : 7);
    const dir = o.dir || 1, out = { keeper: [], striker: [], down: 0, men: 0 };
    for (let cyc = 0; cyc < (o.cycles || 30); cyc++) {
      testSlots = [cyc % 4]; testX = WW / 2;
      resetRound({ roll: true, normal: true });
      phase = 'play'; phaseT = 0; slowT = 0;
      for (let i = 0; i < 40; i++) simTick(TICK);
      const st = chars.map(c => ({ c, prev: null, pressed: false, x0: 0, air: false, t: 0, done: false }));
      for (let i = 0; i < 60 * 8 && st.some(s => !s.done); i++) {
        for (const s of st) {
          if (s.done) continue;
          const c = s.c, lean = angDiff(c.torso.getAngle(), 0) * c.f * dir;
          if (!s.pressed) {
            if (s.prev != null && lean < s.prev && s.prev > 0.05 && c.touch > 0) { s.x0 = c.torso.position.x; press(c); s.pressed = true; }
            s.prev = lean;
          } else {
            s.t += TICK;
            if (c.touch === 0) s.air = true;
            else if (s.air && s.t > 0.25) { s.done = true; (c.keeper ? out.keeper : out.striker).push((c.torso.position.x - s.x0) * c.f * dir); }
          }
        }
        simTick(TICK);
      }
      for (let i = 0; i < 60; i++) simTick(TICK);
      for (const c of chars) { out.men++; if (Math.abs(angDiff(c.torso.getAngle(), 0)) > 1.1) out.down++; }
    }
    testSlots = null; testX = null;
    rng = Math.random;
    const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
    const g = a => ({ n: a.length, p10: pct(a, 0.1), p50: pct(a, 0.5), p90: pct(a, 0.9), wrongWay: +(a.filter(x => x < 0).length / (a.length || 1)).toFixed(2) });
    return { striker: g(out.striker), keeper: g(out.keeper), downAfter: +(out.down / (out.men || 1)).toFixed(3) };
  }

  /* ============================ start ============================ */
  newLooks();
  setPlayersHud();
  syncMute();
  if (SIM) {
    resetRound({ roll: true, normal: true });
    if (mode === 'demo') { phase = 'play'; dropBalls(); }
  }
  if (DIRECT) view = { R, men: chars, balls };
  resize();
  raf = requestAnimationFrame(loop);
  if (mode === 'practice' || mode === 'local2p') {
    hint(touchUI ? (mode === 'local2p' ? 'Tap your half of the pitch to jump and kick' : 'Tap anywhere to jump and kick')
      : (mode === 'local2p' ? players[0].name + ': W    ' + players[1].name + ': ↑' : 'Space, W or ↑ to jump and kick'));
  }

  const api = {
    frame: el.frame,
    overlay: el.overlay,
    get mode() { return mode; },
    get phase() { return phase; },
    get score() { return score.slice(); },
    get hostClock() { return hostClock; },
    get stats() { return stats; },
    // host / practice: begin the 3-2-1 countdown
    startMatch(o) {
      Snd.unlock();
      if (!SIM) return;
      startCountdown(o && o.score);
      if (mode === 'host' || mode === 'practice' || mode === 'local2p') {
        if (mode === 'host') hint(touchUI ? 'Tap anywhere to jump and kick' : 'Space, W or ↑ to jump and kick. A/D for one player.');
      }
    },
    // host: the guest's presses, only ever for the right-hand team
    remotePress(slots) {
      if (mode !== 'host' || paused) return;
      for (const s of slots || []) if ((s === 2 || s === 3) && bySlot[s]) press(bySlot[s]);
    },
    // guest/spectator: data from the host
    pushSnapshot(buf) { if (NET && mode !== 'host') { const f = decodeFrame(buf); if (f) pushFrame(f); } },
    applyRemoteEvent(ev) { if (NET && mode !== 'host') queueEvent(ev); },
    // host: what a newly connected peer needs to start drawing
    getSync() {
      const roundEv = { k: 'round', round, R: Object.assign({}, R), slots: chars.map(c => c.slot), looks: looks.slice(), kits, mods: modsOf(R), t: hostClock };
      return { k: 'sync', players, rules, round: roundEv, score: score.slice(), phase, t: hostClock };
    },
    applySync(s) {
      if (mode === 'host') return;
      players = normPlayers(s.players);
      rules = Object.assign(rules, s.rules || {});
      kits = s.round.kits || resolveKits(players[0].color, players[1].color);
      setPlayersHud();
      frames = []; evq = []; playout = null; lastFxT = s.t - 0.001;
      setRound(s.round);
      showMods(s.round.mods);
      hud.score = [-1, -1];
      updateHud(s.score, null, null, -1);
    },
    setViewDelay(ms) { viewDelay = clamp(ms / 1000, 0.02, 0.4); },
    get viewDelay() { return viewDelay * 1000; },
    get lastFrameAge() { return haveFrame ? performance.now() - lastFrameAt : Infinity; },
    // a grid of matches: draw less often (or not at all while hidden) and at lower
    // resolution, with sound on only the one being looked at
    setRenderEvery(n) { renderEvery = Math.max(1, Math.min(1e9, Math.round(n) || 1)); },
    setMaxDpr(n) { if (opts.maxDpr !== n) { opts.maxDpr = n; resize(); } },
    setSound(on) {
      const was = soundOn, now = NET && frames.length ? frames[frames.length - 1].phase : phase;
      soundOn = !!on;
      if (soundOn) { Snd.unlock(); syncMute(); }
      if (was && !soundOn) Snd.crowdOff(); else if (!was && soundOn && (now === 'play' || now === 'goal')) Snd.crowdOn();
    },
    setPaused(v) { paused = !!v; if (paused && Snd.ctx && Snd.ctx.state === 'running' && !NET) Snd.ctx.suspend(); else if (!paused && Snd.ctx) Snd.ctx.resume(); },
    get paused() { return paused; },
    setInput(v) { inputOn = !!v; },
    setCpuSkill(v) { cpuSkill = v; },
    setBot(skill) { botSkill = skill || 0; },
    setPlayers(p) { players = normPlayers(p); kits = resolveKits(players[0].color, players[1].color); setPlayersHud(); },
    toast, banner, hint,
    // tests
    debug: { get chars() { return chars; }, get balls() { return balls; }, get view() { return view; }, press: s => localPress(s), get frames() { return frames.length; },
      sim: simulate, hops: hopTest, tune: o => Object.assign(TUNE, o), get tuning() { return Object.assign({}, TUNE); } },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
      clearTimeout(toastTimer); clearTimeout(bannerTimer); clearTimeout(hintTimer);
      if (soundOn) Snd.crowdOff();
      root.innerHTML = '';
      world = null;
    }
  };
  return api;
}

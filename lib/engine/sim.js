/* ------------------------------------------------------------------
   THE COTERIE CUP: the simulation
   One-button ragdoll football on planck.js (Box2D): metres, y down, 80 px per
   metre. No browser code: the same file runs the match in the browser (practice,
   one-device matches, a peer-to-peer host, a player's predicted copy) and on the
   match server in Node.

   createSim(o) builds a world and runs it tick by tick. It knows nothing about
   drawing, sound or the network: what happens comes out through callbacks.
     o.mode       practice | local2p | demo | host | server | copy
                  (who the CPU plays; a copy is a player's prediction: it only
                  moves bodies, goals and drop balls are the authority's to decide)
     o.rules      { goals, capSec, modifiers }
     o.players    [{ color }, { color }] for the kits
     o.seed       a fixed seed makes a simulation repeatable
     o.cpuSkill   practice: the CPU on the right
     o.botSkill   tests: the CPU plays the left-hand team (practice, host)
     o.authority  host / server: keeps the stamped presses, the log of presses for
                  the full state and the lean record for the lean check
     o.reduceMotion  no slow motion after a goal
     o.onEvent(ev)          round, count, kickoff, goal, golden, out, end
     o.onFx(type, x, y, v)  cosmetic: kicks, bounces, hops, landings
     o.onScore(score, info), o.onEnd(e)
     o.onPress(slot, tick, lean, round)   authority: a press was applied
   ------------------------------------------------------------------ */
import * as planck from 'planck';
import {
  TAU, WW, GROUND_Y, GOAL_D, BASE_GOAL_H, BAR_T, CEIL_Y, DROP_Y, PPM, GRAV, TICK,
  HEAD_R, TORSO_W, TORSO_H, ARM_W, ARM_H, THIGH_W, THIGH_H, SHIN_W, SHIN_H, FOOT_W, FOOT_H,
  BALL_TYPES, lemonPoints, ballExtent, ballReach, clamp, angDiff, makeRng, shade, resolveKits, FX, PHASES
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
const LEAN_TOL = 0.12;              // rad (about 7°): a press's lean is accepted when the authority had about the same
// where each man stands at kick-off; slots 0 and 3, nearest their own goals, are the keepers
const HOME = [0.19, 0.38, 0.62, 0.81];
export const SKINS = ['#f6d3b8', '#ebb995', '#d39a6a', '#b07646', '#8a5532', '#62391f'];
export const HAIRS = ['#1d1714', '#3a2619', '#6b4426', '#b9884d', '#e2bf73', '#a8432a', '#7d7f86'];
const HAIR_STYLES = ['crop', 'crop', 'buzz', 'puff', 'quiff', 'pony', 'bald'];
const BALL_NAME = { beach: 'Beach ball', rugby: 'Rugby ball', american: 'American football', baseball: 'Baseball', giant: 'Giant ball', tiny: 'Tiny ball', balloon: 'Balloon' };
export const BALL_KEYS = Object.keys(BALL_TYPES);
export const FULL_VERSION = 3;      // first byte of a full state (a snapshot frame starts with 1)

function m(px) { return px / PPM; }
function V(x, y) { return pl.Vec2(x / PPM, y / PPM); }
function goalHFor(gs) { return BASE_GOAL_H * gs; }
export function barUnderFor(gs) { return GROUND_Y - goalHFor(gs); }
export function teamOfSlot(slot) { return slot <= 1 ? 0 : 1; }
export function isKeeper(slot) { return slot === 0 || slot === 3; }
export function palette(kit, look) {
  return {
    shirt: kit.shirt, shirtD: shade(kit.shirt, -0.3), alt: kit.alt,
    shorts: kit.shorts, shortsD: shade(kit.shorts, -0.3), socks: kit.socks, socksD: shade(kit.socks, -0.3),
    boots: kit.boots, bootsD: shade(kit.boots, -0.3), trim: kit.trim,
    gloves: kit.gloves || null, glovesD: kit.gloves ? shade(kit.gloves, -0.3) : null,
    skin: look.skin, skinD: shade(look.skin, -0.24), hair: look.hair
  };
}
export function baseRound() {
  return { goalScale: 1, gravity: 1, slippery: false, bouncy: false, ball: 'normal', twoBalls: false,
    bigHeads: false, longLegs: false };
}
export function modsOf(R) {
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
export function nearestBallOf(list, c) {
  let best = null, bd = 1e9;
  const tp = c.torso.position;
  for (const b of list) {
    const dx = b.position.x - tp.x, dy = b.position.y - tp.y, d = dx * dx + dy * dy * 0.5;
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

export function createSim(o) {
  o = o || {};
  const mode = o.mode || 'practice';
  const AUTH = !!o.authority;
  let rules = Object.assign({ goals: 5, capSec: 0, modifiers: true }, o.rules || {});
  let cpuSkill = o.cpuSkill != null ? o.cpuSkill : 0.74;
  let botSkill = o.botSkill || 0;
  let rng = o.seed != null ? makeRng(o.seed) : Math.random;
  const players = o.players || [{ color: 'orange' }, { color: 'teal' }];
  let kits = resolveKits(players[0].color, players[1].color);
  const reduceMotion = !!o.reduceMotion;
  const fx = (type, x, y, v) => { if (o.onFx) o.onFx(type, x, y, v); };

  let world = null, S = {};
  const chars = [], bySlot = [], balls = [], pending = [];
  let R = baseRound();
  const looks = [];
  let round = 0, score = [0, 0], phase = 'warmup', phaseT = 0, slowT = 0;
  let hostClock = 0, simTime = 0, clockRemain = -1, golden = false, matchOver = false, winner = -1;
  let countN = 0, paused = false;
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
  if (o.tune) Object.assign(TUNE, o.tune);
  let simSkills = null, M = null, forceR = null;          // simulate: CPU on both sides, metrics, forced round
  let testSlots = null, testX = null;                     // hops: one man alone at one spot
  const stats = { respawns: 0, out: { roof: 0, dead: 0, lost: 0 } };
  let bodySeq = 0, groupSeq = 0;
  let restoring = false;            // a copy being put right: contacts are recounted afterwards
  let aiPress = null;               // a player's CPU on a copy decides with the same code, but presses through prediction

  function newLooks() {
    for (let s = 0; s < 6; s++) looks[s] = { skin: pick(SKINS), hair: pick(HAIRS), style: pick(HAIR_STYLES) };
  }
  function rand(a, b) { return a + rng() * (b - a); }
  function pick(arr) { return arr[(rng() * arr.length) | 0]; }
  function chance(p) { return rng() < p; }

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
  function box(b, w, h, opt, ox, oy) {
    const shape = (ox || oy) ? pl.Box(m(w) / 2, m(h) / 2, V(ox || 0, oy || 0), 0) : pl.Box(m(w) / 2, m(h) / 2);
    return b.createFixture(shape, opt);
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
    const s = side < 0 ? 1 : -1, capX = GOAL_D - BAR_T / 2, opt = worldFix(0.4, 0.5, 'bar');
    box(b, capX + 40, BAR_T, opt, s * (capX - 40) / 2, 0);
    b.createFixture(pl.Circle(V(s * capX, 0), m(BAR_T / 2)), opt);
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
    let Mt = 0, cx = 0, cy = 0, I = 0, L = 0, i, b, mi, p;
    for (i = 0; i < ps.length; i++) { b = ps[i]; mi = b.getMass(); p = b.getWorldCenter(); Mt += mi; cx += mi * p.x; cy += mi * p.y; }
    cx /= Mt; cy /= Mt;
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
      if (c.airT > 0.3) { c.landT = 0.16; if (c.airT > 0.5) fx(FX.LAND, c.legs[0].foot.position.x, GROUND_Y, 1); }
      c.airT = 0;
    } else c.airT += dt;
    const upright = Math.abs(lean) < 1.1;
    if (!upright && c.touch > 0) c.lyingT += dt; else c.lyingT = 0;
    // down on the turf: after a moment he scrambles up with a little hop
    const low = c.touch > 0 && GROUND_Y - torso.position.y < c.standH * 0.72;
    c.lowT = low ? c.lowT + dt : 0;
    if (c.lowT > GETUP_T && c.cd <= 0) {
      c.lowT = 0; c.getupT = 0.45; c.cd = 0.2;
      // a little sideways, which way from the moment and the man rather than the random
      // generator, so a player's copy of the match makes the same hop as the authority
      const h = Math.sin(simTime * 127.1 + c.slot * 311.7) * 43758.5453;
      launch(c, (h - Math.floor(h)) * 1.2 - 0.6, -GETUP_V * Math.sqrt(R.gravity));
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
  // seen: the lean to jump with (a press made over the network carries the lean the
  // player saw); otherwise his lean now
  function press(c, seen) {
    if (!c || c.cd > 0 || phase === 'end' || phase === 'countdown') return false;
    c.cd = KICK_CD;
    const lean = seen != null ? seen : angDiff(c.torso.getAngle(), 0);
    if (c.touch > 0 || c.airT < COYOTE) {
      const upright = Math.abs(lean) < 1.1;
      const a = upright ? clamp(lean, -1.1, 1.1) : clamp(lean, -0.5, 0.5);
      const jv = JUMP_V * (upright ? 1 : 0.85);
      launch(c, Math.sin(a) * jv * JUMP_X * (c.keeper ? TUNE.keeperReach : 1), -Math.cos(a) * jv * (c.keeper ? TUNE.keeperJump : 1));
      c.pushT = 0.1;
      fx(FX.HOP, c.torso.position.x, c.torso.position.y, 1);
    }
    c.kickT = KICK_T;
    c.kickLeg = 1 - c.kickLeg;
    // the authority keeps a log of presses (tick and lean) for the players' copies; between
    // ticks a press counts for the next one
    if (AUTH) {
      const n = tickNow || Math.round(hostClock / TICK) + 1;
      pressLog.push({ slot: c.slot, n, lean });
      if (pressLog.length > 40) pressLog.shift();
      if (o.onPress) o.onPress(c.slot, n, lean, round);
    }
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
    const opt = { density: t.den, friction: R.slippery ? 0.04 : t.fric, restitution: t.rest, filterCategoryBits: CAT_BALL };
    if (t.shape === 'capsule') {
      b.createFixture(pl.Box(m(t.half), m(t.r)), opt);
      b.createFixture(pl.Circle(V(-t.half, 0), m(t.r)), opt);
      b.createFixture(pl.Circle(V(t.half, 0), m(t.r)), opt);
    } else if (t.shape === 'lemon') {
      b.createFixture(pl.Polygon(lemonPoints(t.half, t.r).map(([x, y]) => V(x, y))), opt);
    } else b.createFixture(pl.Circle(m(t.r)), opt);
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
    if (restoring) return;
    const fa = contact.getFixtureA(), fb = contact.getFixtureB(), a = fa.getBody(), b = fb.getBody();
    countSupport(a, b, 1); countSupport(b, a, 1);
    if (a.kind === 'ball') ballContact(a, b, fb); else if (b.kind === 'ball') ballContact(b, a, fa);
  }
  function onEnd(contact) {
    if (restoring) return;
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
      fx(tag === 'bar' ? FX.POST : tag === 'net' ? FX.NET : FX.BOUNCE, ball.position.x, ball.position.y, sp);
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
      if (px > 2.4) fx(FX.KICK, b.position.x - q.nx * b.ballR, b.position.y - q.ny * b.ballR, px);
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
    if (o.forceRound) Object.assign(R, o.forceRound);
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
  function roundEvent() {
    return { k: 'round', round, R: Object.assign({}, R), slots: chars.map(c => c.slot), looks: looks.slice(), kits, mods: modsOf(R) };
  }
  function resetRound(opt) {
    if (opt && opt.roll) rollRound(opt.normal);
    chars.length = 0; bySlot.length = 0; balls.length = 0; pending.length = 0;
    buildWorld();
    const slots = testSlots || [0, 1, 2, 3];
    for (const s of slots) { const c = makeMan(spawnSpec(s)); chars.push(c); bySlot[s] = c; }
    if (opt && opt.ball) dropBalls();
    round++;
    emitEvent(roundEvent());
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
  function emitEvent(ev) {
    ev.t = hostClock;
    if (o.onEvent) o.onEvent(ev);
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
    // an own goal only when the other side put it in: a shot that brushes the keeper on its
    // way in is still the shooter's goal
    const own = ball.lastTeam === 1 - team && simTime - ball.touchT[team] > OWN_T;
    for (const c of chars) { c.mood = c.team === team ? 1 : -1; c.moodT = 3; }
    if (score[team] >= rules.goals || golden) { matchOver = true; winner = team; }
    phase = 'goal'; phaseT = 0;
    slowT = reduceMotion ? 0 : 0.9;
    if (M) { M.goals++; M.goalsBy[team]++; if (own) { M.own++; if (ball.lastKeeper) M.ownKeeper++; } }
    emitEvent({ k: 'goal', team, own, side, y: ball.position.y, score: score.slice(), over: matchOver });
    if (o.onScore) o.onScore(score.slice(), { team, own, over: matchOver });
  }
  // a player's copy sees the ball go in too: slow motion and the faces from the same tick as
  // the authority (the score, the banner and the next round are the authority's to decide)
  function copyGoal() {
    const under = barUnderY();
    for (const b of balls) {
      const p = b.position, ex = extX(b);
      if (p.y < under) continue;
      const team = p.x + ex < GOAL_D ? 1 : p.x - ex > WW - GOAL_D ? 0 : -1;
      if (team < 0) continue;
      for (const c of chars) { c.mood = c.team === team ? 1 : -1; c.moodT = 3; }
      phase = 'goal'; phaseT = 0;
      slowT = reduceMotion ? 0 : 0.9;
      return;
    }
  }
  function endMatch(w, reason) {
    matchOver = true; winner = w; phase = 'end'; phaseT = 0;
    emitEvent({ k: 'end', winner: w, score: score.slice(), reason });
    if (o.onEnd) o.onEnd({ winner: w, score: score.slice(), reason });
  }
  // everybody back on their spot for a fair start; a match resumed after the authority
  // restarted carries on from the score it had
  function startCountdown(from) {
    if (phase !== 'warmup') return false;
    resetRound({ roll: true, normal: true });
    phase = 'countdown'; phaseT = 0; countN = 0;
    clockRemain = rules.capSec > 0 ? rules.capSec : -1;
    golden = false; matchOver = false; winner = -1;
    score = from && from.length === 2 ? [Math.max(0, from[0] | 0), Math.max(0, from[1] | 0)] : [0, 0];
    return true;
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
  function restartDemo() {
    score = [0, 0]; matchOver = false; winner = -1; golden = false;
    resetRound({ roll: true, ball: true });
    phase = 'play'; phaseT = 0;
  }

  /* ---------------- CPU ---------------- */
  function aiDo(c) { if (aiPress) aiPress(c); else press(c); }
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
      const fx2 = hx + vx * t, fy = Math.min(GROUND_Y - 6, hy + vy * t + 0.5 * g * t * t);
      const px = bx + bvx * t, py = Math.min(floor, by + bvy * t + 0.5 * g * t * t);
      best = Math.min(best, Math.hypot(fx2 - px, fy - py));
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
    if (rng() < (1 - skill) * 0.08) { aiDo(c); c.ai = react + 0.15; return true; }
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
    if (want > 0 && rng() < want * (0.45 + 0.55 * skill)) { aiDo(c); c.ai = react + rand(0.08, 0.2); return true; }
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
    if (want > 0 && rng() < want * skill) { aiDo(c); c.ai = rand(0.16, 0.36); } else c.ai = rand(0.04, 0.1);
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
  // a player's CPU (tests) on a copy: the same decisions for one team's men, with the
  // presses handed to `pressFn` (prediction stamps them) instead of applied here
  function botTick(dt, team, skill, pressFn) {
    if (phase !== 'play' && phase !== 'goal') return;
    const was = aiPress;
    aiPress = pressFn;
    try { for (const c of chars) if (c.team === team) { if (c.keeper) aiKeeper(c, dt, skill); else aiMan(c, dt, skill); } }
    finally { aiPress = was; }
  }

  /* ---------------- stepping ---------------- */
  // copy: a player's predicted copy, which only moves bodies; goals, drop balls and
  // respawns are the authority's to decide
  function step(dt, copy) {
    if (dt <= 0) return;
    simTime += dt;
    if (!copy) controlAI(dt);
    const sub = dt / SUBSTEPS;
    for (let k = 0; k < SUBSTEPS; k++) {
      const t = simTime - dt + sub * (k + 1);
      for (const c of chars) updateMan(c, sub, t);
      world.step(sub, VEL_IT, POS_IT);
      applyPending();
      syncAll();
    }
    // the "just dropped" ring fades in simulated time, so snapshots carry it for 0.7 s only
    for (const b of balls) if (b.dropT > 0) b.dropT -= dt;
    if (copy) { if (phase === 'play') copyGoal(); return; }
    if (phase === 'play') {
      for (const b of balls) checkBall(b, dt);
      checkGoal();
    } else for (const b of balls) b.warn = 0;
    for (let i = 0; i < chars.length; i++) checkMan(chars[i]);
  }
  // one tick of a player's copy: bodies only, with the slow motion after a goal
  function copyStep(dt) {
    let scale = 1;
    if (slowT > 0) { slowT -= dt; scale = 0.3; }
    step(dt * scale, true);
  }
  let tickNow = 0;                        // the tick being run, while it runs
  function tick(dt) {
    if (remoteQ.length) duePresses(Math.round(hostClock / TICK) + 1);
    hostClock += dt;
    tickNow = Math.round(hostClock / TICK);
    let scale = 1;
    if (slowT > 0) { slowT -= dt; scale = 0.3; }
    step(dt * scale);
    flow(dt);
    if (mode === 'demo' && phase === 'end') restartDemo();
    if (AUTH) recordLeans(tickNow);
    tickNow = 0;
  }

  /* ---------------- the authority: presses stamped with a tick ---------------- */
  // A predicting player stamps each press with the tick its copy applies it on (and the
  // lean its man had in the picture the player was looking at, at tick v). The copy runs
  // far enough ahead that the press normally gets here first; it is then held and applied
  // on exactly that tick, so this match does what the player saw. A late press is applied
  // at once. The lean goes in when this match had about the same at tick v (the lean
  // check); otherwise his lean here. Either way the player hears back how many ticks the
  // press had to spare, and every full state says which presses are in it (ack, per team).
  const remoteQ = [];
  const appliedSeq = [0, 0];
  const lastPress = [];                   // tests: by slot, how the last stamped press went in
  const leanStats = { accepted: 0, own: 0 };   // presses that came with a lean: taken, or his lean here instead
  const pressLog = [];                    // { slot, n, lean } of the presses of the last ticks, for the full state
  const leanHist = [[], [], [], []];      // by slot: { k, a } of his lean after tick k
  function recordLeans(k) {
    for (const c of chars) {
      const h = leanHist[c.slot];
      if (!h) continue;
      let e = h[k & 127];
      if (!e) e = h[k & 127] = { k: 0, a: 0 };
      e.k = k; e.a = angDiff(c.torso.getAngle(), 0);
    }
  }
  function leanAt(slot, k) {
    const h = leanHist[slot], e = h && k != null ? h[k & 127] : null;
    return e && e.k === k ? e.a : null;
  }
  function applyQueued(q) {
    for (let i = 0; i < q.slots.length; i++) {
      const s = q.slots[i], c = bySlot[s];
      if (!c) continue;
      const l = q.leans ? q.leans[i] : null;
      let lean = null;
      if (typeof l === 'number' && isFinite(l)) {
        const ref = q.v != null ? leanAt(s, q.v) : null;
        const now = angDiff(c.torso.getAngle(), 0);
        if (Math.abs(angDiff(l, ref != null ? ref : now)) <= LEAN_TOL) lean = l;
      }
      const used = lean != null ? lean : angDiff(c.torso.getAngle(), 0);
      lastPress[s] = { seq: q.seq, lean: +used.toFixed(4), sent: l != null ? +(+l).toFixed(4) : null, tick: Math.round(hostClock / TICK) + 1, stamped: q.n, accepted: lean != null };
      if (l != null) { if (lean != null) leanStats.accepted++; else leanStats.own++; }
      press(c, lean);
    }
    appliedSeq[q.team] = Math.max(appliedSeq[q.team], q.seq);
  }
  function duePresses(k) {
    for (let i = 0; i < remoteQ.length;) {
      if (remoteQ[i].n <= k) { applyQueued(remoteQ[i]); remoteQ.splice(i, 1); } else i++;
    }
  }
  // team: whose press; slots and leans (one per slot, or none); n: the tick to apply it on;
  // seq: the player's numbering; v: the tick the player was looking at.
  // Returns { slack, at, slots, leans }: ticks to spare (below zero when late), the tick it goes in on
  function queuePress(team, slots, n, seq, leans, v) {
    const ss = [], ls = [];
    (slots || []).forEach((s, i) => {
      if (teamOfSlot(s) !== team || ss.includes(s) || !(s >= 0 && s <= 3)) return;
      ss.push(s);
      const l = Array.isArray(leans) ? Number(leans[i]) : NaN;
      ls.push(isFinite(l) ? clamp(l, -Math.PI, Math.PI) : null);
    });
    const done = Math.round(hostClock / TICK);          // ticks run so far
    const q = { team, slots: ss, leans: ls, n: Math.floor(Number(n)), seq: (Number(seq) || 0) >>> 0, v: typeof v === 'number' && isFinite(v) ? Math.floor(v) : null };
    if (!(q.n > 0) || q.n > done + 120) q.n = done + 1;  // more than 2 s ahead: something is off, take it now
    const slack = q.n - (done + 1);
    const at = Math.max(q.n, done + 1);
    if (paused) appliedSeq[team] = Math.max(appliedSeq[team], q.seq);      // dropped: the player stops expecting it
    else if (q.n <= done + 1) applyQueued(q);
    else if (remoteQ.length < 40) remoteQ.push(q);
    return { slack, at, slots: ss, leans: ls, dropped: paused };
  }

  /* ---------------- full state ---------------- */
  // Everything a player's copy needs to carry on from this tick as the authority will:
  // bodies with their speeds, each man's timers and sway, the balls, the round's rules,
  // the score and clock, and what the solver carries from one step to the next (the
  // joints' and the touching contacts' impulses; without them a copy drifts by pixels
  // within a few ticks, with them it mostly stays exact). It also lists the presses of
  // the last 45 ticks, so a copy that learns of the other player's press from the full
  // state can still play the jump from its start. Binary, about 2.5 KB, 20 a second.
  //   header 51 bytes | per man 294 | per ball 52 | per man's joints 153 | contacts 2 + 7 + 9 a point
  //   | presses 1 + 9 each
  const MAN_F = 13, HEAD = 51;
  function captureState() {
    const nm = chars.length, nb = balls.length;
    const T = Math.round(hostClock / TICK);
    while (pressLog.length && pressLog[0].n < T - 45) pressLog.shift();
    const cts = [];
    let csize = 2;
    for (let ct = world.getContactList(); ct; ct = ct.getNext()) {
      if (!ct.isTouching()) continue;
      const mf = ct.getManifold();
      cts.push(ct); csize += 7 + 9 * mf.pointCount;
      if (cts.length >= 120) break;
    }
    const buf = new ArrayBuffer(HEAD + nm * (2 + 4 * (MAN_F + 60)) + nb * 52 + nm * 153 + csize + 1 + 9 * pressLog.length);
    const v = new DataView(buf);
    let p = 0;
    const u8 = x => { v.setUint8(p, x); p += 1; }, u16 = x => { v.setUint16(p, x, true); p += 2; }, f32 = x => { v.setFloat32(p, x, true); p += 4; };
    u8(FULL_VERSION); u8(Math.max(0, PHASES.indexOf(phase)));
    u16(round & 0xffff);
    v.setFloat64(p, hostClock, true); p += 8;
    v.setFloat64(p, simTime, true); p += 8;
    f32(Math.max(0, slowT));
    v.setUint32(p, appliedSeq[0] >>> 0, true); p += 4;
    v.setUint32(p, appliedSeq[1] >>> 0, true); p += 4;
    u8(nm); u8(nb);
    f32(R.goalScale); f32(R.gravity);
    u8((R.slippery ? 1 : 0) | (R.bouncy ? 2 : 0) | (R.twoBalls ? 4 : 0) | (R.bigHeads ? 8 : 0) | (R.longLegs ? 16 : 0));
    u8(Math.max(0, BALL_KEYS.indexOf(R.ball)));
    u8(Math.min(255, score[0])); u8(Math.min(255, score[1]));
    f32(clockRemain);
    u8((golden ? 1 : 0) | (matchOver ? 2 : 0) | ((winner + 1) << 2));
    for (const c of chars) {
      u8(c.slot); u8((c.kickLeg & 1) | ((clamp(c.mood | 0, -1, 1) + 1) << 1));
      f32(c.rockAmp); f32(c.rockW); f32(c.phase); f32(c.homeX);
      f32(c.cd); f32(c.kickT); f32(c.pushT); f32(c.landT); f32(c.airT); f32(c.lyingT); f32(c.lowT); f32(c.getupT); f32(c.moodT);
      // angles as they are, not wrapped: the joints work on differences between parts
      for (const b of c.parts) { const q = b.getPosition(), lv = b.getLinearVelocity(); f32(q.x); f32(q.y); f32(b.getAngle()); f32(lv.x); f32(lv.y); f32(b.getAngularVelocity()); }
    }
    for (const b of balls) {
      const q = b.getPosition(), lv = b.getLinearVelocity();
      f32(q.x); f32(q.y); f32(angDiff(b.getAngle(), 0)); f32(lv.x); f32(lv.y); f32(b.getAngularVelocity());
      f32(b.dropT); f32(b.warn);
      for (let s = 0; s < 4; s++) { const a = b.assistT[s]; f32(a == null ? 99 : Math.min(99, simTime - a)); }
      f32(Math.min(99, simTime - b.lastSnd));
    }
    for (const c of chars) for (const j of jointsOf(c)) { f32(j.m_impulse.x); f32(j.m_impulse.y); f32(j.m_impulse.z); f32(j.m_motorImpulse); u8(j.m_limitState | 0); }
    u16(cts.length);
    for (const ct of cts) {
      const mf = ct.getManifold();
      u16(fixCode(ct.getFixtureA())); u8(ct.getChildIndexA()); u16(fixCode(ct.getFixtureB())); u8(ct.getChildIndexB());
      u8(mf.pointCount);
      for (let i = 0; i < mf.pointCount; i++) { const q = mf.points[i]; u8(q.id.key & 255); f32(q.normalImpulse); f32(q.tangentImpulse); }
    }
    u8(pressLog.length);
    for (const q of pressLog) { u8(q.slot); v.setUint32(p, q.n >>> 0, true); p += 4; f32(q.lean); }
    return buf;
  }
  // a snapshot frame (shared.encodeFrame): every body's position and angle, the score and
  // clock; fx are the cosmetic effects since the last one
  function captureFrame(fxList) {
    const men = [];
    for (const c of chars) {
      const q = new Float32Array(30);
      for (let i = 0; i < 10; i++) { const b = c.parts[i]; q[i * 3] = b.position.x; q[i * 3 + 1] = b.position.y; q[i * 3 + 2] = b.angle; }
      const bits = (c.kickT > 0 ? 1 : 0) | (c.airT > 0.25 ? 2 : 0) | ((c.moodT > 0 ? c.mood + 1 : 1) << 2);
      men.push({ slot: c.slot, bits, p: q });
    }
    return {
      t: hostClock, phase, round, score: score.slice(), clock: clockRemain, golden,
      // ball bits: 1 = just dropped, bits 1-7 = how far the "about to be dropped again" ring has wound down
      men, balls: balls.map(b => ({ x: b.position.x, y: b.position.y, a: b.angle, bits: (b.dropT > 0 ? 1 : 0) | (Math.round(clamp(b.warn, 0, 1) * 127) << 1) })),
      fx: fxList || []
    };
  }

  /* ---------------- a copy: built and put right from full states ---------------- */
  // a copy of the authority's round: same rules, men with the same sway
  function buildCopy(fs) {
    R = Object.assign(baseRound(), fs.R);
    chars.length = 0; bySlot.length = 0; balls.length = 0; pending.length = 0;
    restoring = true;
    buildWorld();
    for (const ms of fs.men) {
      const slot = ms.slot, team = teamOfSlot(slot), keeper = isKeeper(slot);
      const kit = keeper ? (team === 0 ? kits.keepA : kits.keepB) : (team === 0 ? kits.a : kits.b);
      const c = makeMan({ slot, team, keeper, x: ms.homeX, kit, look: looks[slot] || looks[0], hs: R.bigHeads ? 1.42 : 1, ls: R.longLegs ? 1.4 : 1,
        rockAmp: ms.rockAmp, rockW: ms.rockW, phase: ms.phase });
      chars.push(c); bySlot[slot] = c;
    }
    for (let i = 0; i < fs.balls.length; i++) makeBall(WW / 2, DROP_Y, R.ball);
    restoring = false;
  }
  function setBody(b, q, i) {
    b.setTransform(pl.Vec2(q[i], q[i + 1]), q[i + 2]);
    b.setLinearVelocity(pl.Vec2(q[i + 3], q[i + 4]));
    b.setAngularVelocity(q[i + 5]);
    mirror(b);
  }
  // put the copy exactly where the authority was at that tick; false when the balls had to be
  // made again (their number changed)
  function restoreCopy(fs) {
    restoring = true;
    let rebuiltBalls = false;
    simTime = fs.simTime; slowT = fs.slowT; phase = fs.phase;
    if (fs.score) { score = fs.score.slice(); clockRemain = fs.clock; golden = fs.golden; }
    for (const ms of fs.men) {
      const c = bySlot[ms.slot];
      if (!c) continue;
      c.kickLeg = ms.kickLeg; c.mood = ms.mood; c.moodT = ms.moodT;
      c.rockAmp = ms.rockAmp; c.rockW = ms.rockW; c.phase = ms.phase; c.homeX = ms.homeX;
      c.cd = ms.cd; c.kickT = ms.kickT; c.pushT = ms.pushT; c.landT = ms.landT; c.airT = ms.airT;
      c.lyingT = ms.lyingT; c.lowT = ms.lowT; c.getupT = ms.getupT;
      for (let k = 0; k < 10; k++) setBody(c.parts[k], ms.p, k * 6);
    }
    if (balls.length !== fs.balls.length) {
      for (const b of balls) world.destroyBody(b);
      balls.length = 0;
      for (let i = 0; i < fs.balls.length; i++) makeBall(WW / 2, DROP_Y, R.ball);
      rebuiltBalls = true;
    }
    fs.balls.forEach((fb, i) => {
      const b = balls[i];
      setBody(b, fb.p, 0);
      b.dropT = fb.dropT; b.warn = fb.warn; b.lastSnd = simTime - fb.snd;
      b.assistT = {};
      for (let s = 0; s < 4; s++) if (fb.assist[s] < 90) b.assistT[s] = simTime - fb.assist[s];
    });
    pending.length = 0;
    // the contacts at the restored positions, then who is standing on what
    world.findNewContacts();
    world.updateContacts();
    // and what the solver carries over from the authority's last step, so the copy goes on as it will
    for (let ct = world.getContactList(); ct; ct = ct.getNext()) {
      if (!ct.isTouching()) continue;
      const pts = fs.contacts.get(fixCode(ct.getFixtureA()) + ':' + ct.getChildIndexA() + ':' + fixCode(ct.getFixtureB()) + ':' + ct.getChildIndexB());
      const mf = ct.getManifold();
      for (let i = 0; i < mf.pointCount; i++) {
        const q = mf.points[i];
        q.normalImpulse = 0; q.tangentImpulse = 0;
        if (pts) for (let j = 0; j < pts.length; j += 3) if (pts[j] === (q.id.key & 255)) { q.normalImpulse = pts[j + 1]; q.tangentImpulse = pts[j + 2]; break; }
      }
    }
    for (const ms of fs.men) {
      const c = bySlot[ms.slot];
      if (!c || !ms.j) continue;
      let k = 0;
      for (const j of jointsOf(c)) { j.m_impulse.x = ms.j[k]; j.m_impulse.y = ms.j[k + 1]; j.m_impulse.z = ms.j[k + 2]; j.m_motorImpulse = ms.j[k + 3]; j.m_limitState = ms.j[k + 4]; k += 5; }
    }
    for (const c of chars) { c.touch = 0; c.feet = 0; }
    for (let ct = world.getContactList(); ct; ct = ct.getNext()) {
      if (!ct.isTouching()) continue;
      const a = ct.getFixtureA().getBody(), b = ct.getFixtureB().getBody();
      countSupport(a, b, 1); countSupport(b, a, 1);
    }
    restoring = false;
    return !rebuiltBalls;
  }
  function jointsOf(c) { return [c.neck, c.shNear, c.shFar, c.legs[0].hip, c.legs[0].knee, c.legs[0].ankle, c.legs[1].hip, c.legs[1].knee, c.legs[1].ankle]; }
  function fixCode(f) {
    const b = f.getBody();
    let i = 0;
    for (let x = b.getFixtureList(); x && x !== f; x = x.getNext()) i++;
    if (b.kind === 'man') return 1000 + b.owner.slot * 100 + b.owner.parts.indexOf(b) * 4 + i;
    if (b.kind === 'ball') return 2000 + balls.indexOf(b) * 4 + i;
    return [S.ground, S.wallL, S.wallR, S.ceil, S.barL, S.barR].indexOf(b) * 4 + i;
  }

  /* ============================ test harness ============================ */
  // simulate plays CPU against CPU synchronously (no drawing) and measures how
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
  function simulate(opt) {
    if (mode !== 'practice') return null;
    opt = opt || {};
    if (opt.tune) Object.assign(TUNE, opt.tune);
    rng = makeRng(opt.seed != null ? opt.seed : 1);
    simSkills = opt.skills || [0.8, 0.8];
    forceR = opt.force || null;
    const saved = rules;
    rules = Object.assign({}, rules, { goals: 1e6, capSec: 0, modifiers: !!opt.modifiers });
    score = [0, 0]; matchOver = false; golden = false; winner = -1; stats.respawns = 0; stats.out = { roof: 0, dead: 0, lost: 0 };
    newLooks();
    resetRound({ roll: true, normal: !opt.modifiers, ball: true });
    phase = 'play'; phaseT = 0; slowT = 0;
    M = { playTicks: 0, manTicks: 0, lying: 0, air: 0, goals: 0, own: 0, ownKeeper: 0, goalsBy: [0, 0], deadSaves: 0, roofSaves: 0, lateStill: 0, keeper: { apex: [], hop: [] }, striker: { apex: [], hop: [] } };
    const n = Math.round((opt.seconds || 60) / TICK);
    for (let i = 0; i < n; i++) { tick(TICK); simCollect(); }
    const pct = (a, q) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1); };
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

  // replay: how faithfully a copy restored from a full state carries on. Plays a while,
  // takes the full state, runs `ticks` more, puts the state back and runs them again,
  // then compares tick by tick (largest gap in px, rad and m/s). Practice only.
  //   o.joints / o.contacts: also put back the joints' and contacts' carried-over impulses
  //   o.noWarm: warm starting off in the solver for both runs
  function grabJoints() {
    const out = [];
    for (const c of chars) for (const j of jointsOf(c)) out.push(j.m_impulse.x, j.m_impulse.y, j.m_impulse.z, j.m_motorImpulse, j.m_limitState);
    return out;
  }
  function putJoints(a) {
    let i = 0;
    for (const c of chars) for (const j of jointsOf(c)) { j.m_impulse.x = a[i++]; j.m_impulse.y = a[i++]; j.m_impulse.z = a[i++]; j.m_motorImpulse = a[i++]; j.m_limitState = a[i++]; }
  }
  function grabContacts() {
    const out = new Map();
    for (let ct = world.getContactList(); ct; ct = ct.getNext()) {
      if (!ct.isTouching()) continue;
      const mf = ct.getManifold(), pts = [];
      for (let i = 0; i < mf.pointCount; i++) pts.push(mf.points[i].id.key, mf.points[i].normalImpulse, mf.points[i].tangentImpulse);
      out.set(fixCode(ct.getFixtureA()) + ':' + ct.getChildIndexA() + ':' + fixCode(ct.getFixtureB()) + ':' + ct.getChildIndexB(), pts);
    }
    return out;
  }
  function putContacts(map) {
    let hit = 0, miss = 0;
    for (let ct = world.getContactList(); ct; ct = ct.getNext()) {
      if (!ct.isTouching()) continue;
      const pts = map.get(fixCode(ct.getFixtureA()) + ':' + ct.getChildIndexA() + ':' + fixCode(ct.getFixtureB()) + ':' + ct.getChildIndexB());
      if (!pts) { miss++; continue; }
      hit++;
      const mf = ct.getManifold();
      for (let i = 0; i < mf.pointCount; i++) {
        const q = mf.points[i];
        for (let j = 0; j < pts.length; j += 3) if (pts[j] === q.id.key) { q.normalImpulse = pts[j + 1]; q.tangentImpulse = pts[j + 2]; break; }
      }
    }
    return { hit, miss };
  }
  // the bodies now, as one array (positions, angles and speeds of every part and ball, as
  // 32-bit floats like a player's record of its copy)
  function snapshotBodies() {
    const a = new Float32Array((chars.length * 10 + balls.length) * 5);
    let i = 0;
    for (const c of chars) for (const b of c.parts) { const q = b.getPosition(), v = b.getLinearVelocity(); a[i++] = q.x; a[i++] = q.y; a[i++] = b.getAngle(); a[i++] = v.x; a[i++] = v.y; }
    for (const b of balls) { const q = b.getPosition(), v = b.getLinearVelocity(); a[i++] = q.x; a[i++] = q.y; a[i++] = 0; a[i++] = v.x; a[i++] = v.y; }
    return a;
  }
  function gapTo(a) {
    let i = 0, px = 0, ang = 0, vel = 0;
    for (const c of chars) for (const b of c.parts) {
      const q = b.getPosition(), v = b.getLinearVelocity();
      px = Math.max(px, Math.hypot(q.x - a[i], q.y - a[i + 1]) * PPM);
      ang = Math.max(ang, Math.abs(b.getAngle() - a[i + 2]));
      vel = Math.max(vel, Math.hypot(v.x - a[i + 3], v.y - a[i + 4]));
      i += 5;
    }
    for (const b of balls) {
      const q = b.getPosition(), v = b.getLinearVelocity();
      px = Math.max(px, Math.hypot(q.x - a[i], q.y - a[i + 1]) * PPM);
      vel = Math.max(vel, Math.hypot(v.x - a[i + 3], v.y - a[i + 4]));
      i += 5;
    }
    return { px, ang, vel };
  }
  function replayTest(opt) {
    if (mode !== 'practice') return null;
    opt = opt || {};
    rng = makeRng(opt.seed != null ? opt.seed : 5);
    simSkills = [0, 0];
    const ticks = opt.ticks || 15, trials = opt.trials || 30, at = [3, 6, 10, 15, 30].filter(x => x <= ticks);
    resetRound({ roll: true, normal: true, ball: true });
    phase = 'play'; phaseT = 0; slowT = 0;
    world.setWarmStarting(!opt.noWarm);
    const gaps = at.map(() => ({ px: [], ang: [], vel: [] }));
    let hits = 0, misses = 0;
    for (let tr = 0; tr < trials; tr++) {
      for (let i = 0; i < 30 + (tr * 13) % 60; i++) {
        if (rng() < 0.04) press(chars[(rng() * chars.length) | 0]);
        step(TICK, true);
      }
      const fs = decodeState(captureState()), joints = grabJoints(), contacts = grabContacts();
      const rec = [];
      for (let k = 1; k <= ticks; k++) { step(TICK, true); rec[k] = snapshotBodies(); }
      restoreCopy(fs);
      if (opt.joints) putJoints(joints);
      if (opt.contacts) { const r = putContacts(contacts); hits += r.hit; misses += r.miss; }
      for (let k = 1; k <= ticks; k++) {
        step(TICK, true);
        const j = at.indexOf(k);
        if (j >= 0) { const g = gapTo(rec[k]); gaps[j].px.push(g.px); gaps[j].ang.push(g.ang); gaps[j].vel.push(g.vel); }
      }
    }
    world.setWarmStarting(true);
    simSkills = null; rng = Math.random;
    const pct = (a, q) => { const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(3); };
    const out = { contacts: opt.contacts ? { hits, misses } : undefined };
    at.forEach((k, j) => { out['t' + k] = { pxP50: pct(gaps[j].px, 0.5), pxP90: pct(gaps[j].px, 0.9), pxMax: pct(gaps[j].px, 1), angP90: pct(gaps[j].ang, 0.9), velP50: pct(gaps[j].vel, 0.5), velP90: pct(gaps[j].vel, 0.9) }; });
    return out;
  }

  // hops: every man presses once, at the peak of his lean toward `dir` (1 forward, -1
  // back), like a player timing the swing. Measures the hop distance (px, + = the way
  // he leaned) and whether he is down a second later.
  function hopTest(opt) {
    if (mode !== 'practice') return null;
    opt = opt || {};
    if (opt.tune) Object.assign(TUNE, opt.tune);
    rng = makeRng(opt.seed != null ? opt.seed : 7);
    const dir = opt.dir || 1, out = { keeper: [], striker: [], down: 0, men: 0 };
    for (let cyc = 0; cyc < (opt.cycles || 30); cyc++) {
      testSlots = [cyc % 4]; testX = WW / 2;
      resetRound({ roll: true, normal: true });
      phase = 'play'; phaseT = 0; slowT = 0;
      for (let i = 0; i < 40; i++) tick(TICK);
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
        tick(TICK);
      }
      for (let i = 0; i < 60; i++) tick(TICK);
      for (const c of chars) { out.men++; if (Math.abs(angDiff(c.torso.getAngle(), 0)) > 1.1) out.down++; }
    }
    testSlots = null; testX = null;
    rng = Math.random;
    const pct = (a, q) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1); };
    const g = a => ({ n: a.length, p10: pct(a, 0.1), p50: pct(a, 0.5), p90: pct(a, 0.9), wrongWay: +(a.filter(x => x < 0).length / (a.length || 1)).toFixed(2) });
    return { striker: g(out.striker), keeper: g(out.keeper), downAfter: +(out.down / (out.men || 1)).toFixed(3) };
  }

  /* ============================ start ============================ */
  newLooks();

  return {
    get mode() { return mode; },
    get world() { return world; },
    get chars() { return chars; },
    get bySlot() { return bySlot; },
    get balls() { return balls; },
    get R() { return R; },
    get round() { return round; },
    get score() { return score; },
    get phase() { return phase; },
    get phaseT() { return phaseT; },
    get slowT() { return slowT; },
    get hostClock() { return hostClock; },
    get ticks() { return Math.round(hostClock / TICK); },           // ticks run so far
    get simTime() { return simTime; },
    get clockRemain() { return clockRemain; },
    get golden() { return golden; },
    get matchOver() { return matchOver; },
    get winner() { return winner; },
    get kits() { return kits; },
    set kits(k) { kits = k; },
    get looks() { return looks; },
    get rules() { return rules; },
    set rules(r) { rules = Object.assign({}, rules, r); },
    get stats() { return stats; },
    get tune() { return TUNE; },
    get paused() { return paused; },
    get lastPress() { return lastPress; },
    get leanStats() { return leanStats; },
    get appliedSeq() { return appliedSeq; },
    tick, step, copyStep, press, resetRound, dropBalls, startCountdown, restartDemo, roundEvent, botTick,
    // the landing page's CPU match: straight into play
    startDemo() { phase = 'play'; phaseT = 0; dropBalls(); },
    setCpuSkill(v) { cpuSkill = v; },
    setBot(v) { botSkill = v || 0; },
    // an authority that stops: presses still on their way are dropped (the players stop expecting them)
    setPaused(v) {
      paused = !!v;
      if (paused && remoteQ.length) { for (const q of remoteQ) appliedSeq[q.team] = Math.max(appliedSeq[q.team], q.seq); remoteQ.length = 0; }
    },
    // a player (re)connected: they number their presses from their own start
    resetSeq(team) { appliedSeq[team] = 0; for (let i = remoteQ.length - 1; i >= 0; i--) if (remoteQ[i].team === team) remoteQ.splice(i, 1); },
    queuePress, captureState, captureFrame, buildCopy, restoreCopy,
    // tests
    simulate, hops: hopTest, replay: replayTest
  };
}

// a full state as numbers (see captureState); null if it isn't one
export function decodeState(buf) {
  const v = new DataView(buf);
  const MAN_F = 13, HEAD = 51;
  if (v.byteLength < HEAD || v.getUint8(0) !== FULL_VERSION) return null;
  let o = 1;
  const u8 = () => v.getUint8(o++), u16 = () => { const x = v.getUint16(o, true); o += 2; return x; }, f32 = () => { const x = v.getFloat32(o, true); o += 4; return x; };
  const s = { men: [], balls: [], contacts: new Map() };
  s.phase = PHASES[u8()] || 'play';
  s.round = u16();
  s.t = v.getFloat64(o, true); o += 8;
  s.simTime = v.getFloat64(o, true); o += 8;
  s.slowT = f32();
  s.ack = [v.getUint32(o, true), v.getUint32(o + 4, true)]; o += 8;
  const nm = u8(), nb = u8();
  if (v.byteLength < HEAD + nm * (2 + 4 * (MAN_F + 60)) + nb * 52 + nm * 153 + 2) return null;
  const goalScale = f32(), gravity = f32(), fl = u8(), bi = u8();
  s.R = { goalScale, gravity, slippery: !!(fl & 1), bouncy: !!(fl & 2), twoBalls: !!(fl & 4), bigHeads: !!(fl & 8), longLegs: !!(fl & 16), ball: BALL_KEYS[bi] || 'normal' };
  s.score = [u8(), u8()];
  s.clock = f32();
  const hf = u8();
  s.golden = !!(hf & 1); s.over = !!(hf & 2); s.winner = (hf >> 2) - 1;
  for (let i = 0; i < nm; i++) {
    const slot = u8(), bits = u8();
    const mm = { slot, kickLeg: bits & 1, mood: ((bits >> 1) & 3) - 1 };
    mm.rockAmp = f32(); mm.rockW = f32(); mm.phase = f32(); mm.homeX = f32();
    mm.cd = f32(); mm.kickT = f32(); mm.pushT = f32(); mm.landT = f32(); mm.airT = f32(); mm.lyingT = f32(); mm.lowT = f32(); mm.getupT = f32(); mm.moodT = f32();
    mm.p = new Float32Array(60);
    for (let k = 0; k < 60; k++) mm.p[k] = f32();
    s.men.push(mm);
  }
  for (let i = 0; i < nb; i++) {
    const b = { p: new Float32Array(6) };
    for (let k = 0; k < 6; k++) b.p[k] = f32();
    b.dropT = f32(); b.warn = f32();
    b.assist = [f32(), f32(), f32(), f32()];
    b.snd = f32();
    s.balls.push(b);
  }
  for (const mm of s.men) {
    mm.j = new Float32Array(45);
    for (let k = 0; k < 45; k += 5) { mm.j[k] = f32(); mm.j[k + 1] = f32(); mm.j[k + 2] = f32(); mm.j[k + 3] = f32(); mm.j[k + 4] = u8(); }
  }
  const nc = u16();
  for (let i = 0; i < nc && o + 7 <= v.byteLength; i++) {
    const key = u16() + ':' + u8() + ':' + u16() + ':' + u8(), n = u8(), pts = [];
    if (o + 9 * n > v.byteLength) break;
    for (let k = 0; k < n; k++) pts.push(u8(), f32(), f32());
    s.contacts.set(key, pts);
  }
  s.presses = [];
  if (o < v.byteLength) {
    const np = u8();
    for (let i = 0; i < np && o + 9 <= v.byteLength; i++) { const slot = u8(), n = v.getUint32(o, true); o += 4; s.presses.push({ slot, n, lean: f32() }); }
  }
  s.tick = Math.round(s.t / TICK);
  return s;
}

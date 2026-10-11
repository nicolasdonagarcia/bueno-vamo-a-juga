/* Shared pieces of the match engine: world constants, kit colours, the binary
   snapshot format sent from host to guest, and one shared AudioContext. */

export const TAU = Math.PI * 2;

// world, in px (80 px per metre, y down)
export const WH = 720;
export const WW = 1060;            // fixed width so both players simulate/see the same pitch
export const GROUND_Y = 590;
export const GOAL_D = 128;         // goal depth; x = GOAL_D is the goal line
export const BASE_GOAL_H = 286;    // turf to the underside of the crossbar
export const BAR_T = 14;
export const CEIL_Y = -250;
export const DROP_Y = 110;
export const PPM = 80;
export const GRAV = 17.75;         // m/s^2 = 1420 px/s^2
export const TICK = 1 / 60;

// ragdoll dimensions (px)
export const HEAD_R = 21, TORSO_W = 30, TORSO_H = 46, ARM_W = 10, ARM_H = 34;
export const THIGH_W = 15, THIGH_H = 28, SHIN_W = 12, SHIN_H = 28, FOOT_W = 26, FOOT_H = 10;

// Balls. r is the radius (for the long balls: half their height); half is
// half the length of a long ball. The rugby ball is a capsule with round
// ends, the American football a lemon with pointed tips (a polygon), so it
// bounces off the turf in odd directions.
export const BALL_TYPES = {
  normal:   { r: 19, rest: 0.72, den: 3.4, damp: 0.06, adamp: 0.25, fric: 0.25 },
  beach:    { r: 30, rest: 0.82, den: 0.9, damp: 0.35, adamp: 0.4,  fric: 0.3 },
  giant:    { r: 36, rest: 0.68, den: 1.2, damp: 0.1,  adamp: 0.3,  fric: 0.3 },
  tiny:     { r: 12, rest: 0.8,  den: 7.5, damp: 0.06, adamp: 0.2,  fric: 0.25 },
  balloon:  { r: 31, rest: 0.85, den: 0.3, damp: 2.0,  adamp: 1.0,  fric: 0.3 },
  baseball: { r: 14, rest: 0.55, den: 6.2, damp: 0.03, adamp: 0.15, fric: 0.4 },
  rugby:    { r: 17, half: 15, shape: 'capsule', rest: 0.7, den: 3.2, damp: 0.08, adamp: 0.3, fric: 0.3 },
  american: { r: 16, half: 27, shape: 'lemon', rest: 0.62, den: 3.1, damp: 0.07, adamp: 0.22, fric: 0.35 }
};
export const RUGBY_HALF = BALL_TYPES.rugby.half;
// outline of the American football: tips at +-half, a parabola in between
export function lemonPoints(half, r) {
  const xs = [1, 0.63, 0.26], pts = [];
  for (const k of xs) pts.push([k * half, k === 1 ? 0 : -r * (1 - k * k)]);
  for (const k of xs.slice(1).reverse()) pts.push([-k * half, -r * (1 - k * k)]);
  pts.push([-half, 0]);
  for (const k of xs.slice(1)) pts.push([-k * half, r * (1 - k * k)]);
  for (const k of xs.slice(1).reverse()) pts.push([k * half, r * (1 - k * k)]);
  return pts;
}
// half extents of a ball at its angle (px), for the goal line and the goal roof
export function ballExtent(type, r, angle) {
  const t = BALL_TYPES[type] || BALL_TYPES.normal, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  if (t.shape === 'capsule') return { x: t.half * c + r, y: t.half * s + r };
  if (t.shape === 'lemon') return { x: Math.sqrt((t.half * c) ** 2 + (r * s) ** 2), y: Math.sqrt((t.half * s) ** 2 + (r * c) ** 2) };
  return { x: r, y: r };
}
// the furthest any part of the ball reaches from its centre
export function ballReach(type) {
  const t = BALL_TYPES[type] || BALL_TYPES.normal;
  return t.shape === 'capsule' ? t.half + t.r : t.shape === 'lemon' ? t.half : t.r;
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function angDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
  return d;
}
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
export function shade(hex, amt) {
  let [r, g, b] = hexRgb(hex);
  if (amt < 0) { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  else { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
}

/* ------------------------- kit colours -------------------------
   Every player picks one. In a match the right-hand player switches to an
   away kit when the two are too alike to tell apart at a glance.          */
export const COLORS = [
  { id: 'orange', name: 'Orange', hex: '#ff7a1a', shorts: '#1b2147', boots: '#f4f4f8', trim: '#1b2147' },
  { id: 'teal', name: 'Teal', hex: '#14b8cc', shorts: '#f4f6fb', boots: '#1b2147', trim: '#0a5866' },
  { id: 'red', name: 'Red', hex: '#e5383b', shorts: '#f4f6fb', boots: '#1b2147', trim: '#ffffff' },
  { id: 'blue', name: 'Blue', hex: '#3a5bd9', shorts: '#f4f6fb', boots: '#ffd43b', trim: '#ffffff' },
  { id: 'green', name: 'Green', hex: '#2fbf71', shorts: '#1b2147', boots: '#f4f4f8', trim: '#1b2147' },
  { id: 'purple', name: 'Purple', hex: '#8e5cf7', shorts: '#1b2147', boots: '#f4f4f8', trim: '#ffd43b' },
  { id: 'yellow', name: 'Yellow', hex: '#ffd43b', shorts: '#1b2147', boots: '#1b2147', trim: '#1b2147' },
  { id: 'pink', name: 'Pink', hex: '#ff5ca8', shorts: '#1b2147', boots: '#f4f4f8', trim: '#ffffff' },
  { id: 'white', name: 'White', hex: '#eef1f7', shorts: '#1b2147', boots: '#1b2147', trim: '#1b2147' },
  { id: 'black', name: 'Black', hex: '#2b2f4a', shorts: '#2b2f4a', boots: '#ffd43b', trim: '#ffd43b' }
];
export function colorById(id) { return COLORS.find(c => c.id === id) || COLORS[0]; }
// a team colour as text or glow on the dark scoreboard: very dark kits get lifted
export function readable(hex) {
  return lum(hex) < 0.3 ? shade(hex, 0.62) : hex;
}
function lum(hex) { const [r, g, b] = hexRgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
function mixHex(a, b, t) {
  const x = hexRgb(a), y = hexRgb(b);
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function colorDist(a, b) {
  const x = hexRgb(a), y = hexRgb(b);
  return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2);
}
function kitFrom(c) {
  return { shirt: c.hex, alt: c.trim, pattern: 'plain', shorts: c.shorts, socks: c.hex, boots: c.boots, trim: c.trim };
}
// The goalkeeper (each team's back man) stays in his team's colour so you can
// always tell your two men apart, but in a darker or lighter shade, with big gloves.
function keeperKit(c) {
  const shirt = lum(c.hex) < 0.3 ? mixHex(c.hex, '#ffffff', 0.3) : mixHex(c.hex, '#0b0e26', 0.3);
  const gloves = colorDist(c.hex, '#c6f432') < 170 ? '#f4f6fb' : '#c6f432';
  return { shirt, alt: c.trim, pattern: 'keeper', shorts: c.shorts, socks: c.hex, boots: c.boots, trim: c.trim, gloves };
}
// kits for a match: { a, b, keepA, keepB, hexA, hexB }
export function resolveKits(idA, idB) {
  const ca = colorById(idA);
  let cb = colorById(idB);
  if (colorDist(ca.hex, cb.hex) < 125) cb = colorById(ca.id === 'white' ? 'black' : 'white');
  if (colorDist(ca.hex, cb.hex) < 125) cb = colorById('black');
  return { a: kitFrom(ca), b: kitFrom(cb), keepA: keeperKit(ca), keepB: keeperKit(cb), hexA: ca.hex, hexB: cb.hex };
}

/* ------------------------- snapshots -------------------------
   Host -> guest, about 30 per second, over an unreliable channel.
   header 20 bytes | per man 62 bytes | per ball 7 bytes | per effect 7 bytes  */
export const PHASES = ['warmup', 'countdown', 'play', 'goal', 'end'];
export function encodeFrame(f) {
  const nm = f.men.length, nb = f.balls.length, nf = Math.min(255, f.fx.length);
  const buf = new ArrayBuffer(20 + nm * 62 + nb * 7 + nf * 7);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o, 1); o += 1;
  v.setUint8(o, Math.max(0, PHASES.indexOf(f.phase))); o += 1;
  v.setUint16(o, f.round, true); o += 2;
  v.setFloat64(o, f.t, true); o += 8;
  v.setUint8(o, f.score[0]); o += 1;
  v.setUint8(o, f.score[1]); o += 1;
  v.setUint16(o, f.clock < 0 ? 0xffff : Math.round(Math.min(6000, f.clock) * 10), true); o += 2;
  v.setUint8(o, f.golden ? 1 : 0); o += 1;
  v.setUint8(o, nm); o += 1;
  v.setUint8(o, nb); o += 1;
  v.setUint8(o, nf); o += 1;
  for (const man of f.men) {
    v.setUint8(o, man.slot); o += 1;
    v.setUint8(o, man.bits); o += 1;
    for (let i = 0; i < 30; i += 3) {
      v.setInt16(o, Math.round(clamp(man.p[i], -3200, 3200) * 10), true); o += 2;
      v.setInt16(o, Math.round(clamp(man.p[i + 1], -3200, 3200) * 10), true); o += 2;
      v.setInt16(o, Math.round(angDiff(man.p[i + 2], 0) * 10000), true); o += 2;
    }
  }
  for (const b of f.balls) {
    v.setInt16(o, Math.round(clamp(b.x, -3200, 3200) * 10), true); o += 2;
    v.setInt16(o, Math.round(clamp(b.y, -3200, 3200) * 10), true); o += 2;
    v.setInt16(o, Math.round(angDiff(b.a, 0) * 10000), true); o += 2;
    v.setUint8(o, b.bits); o += 1;
  }
  for (let i = 0; i < nf; i++) {
    const e = f.fx[i];
    v.setUint8(o, e.type); o += 1;
    v.setInt16(o, Math.round(clamp(e.x, -3200, 3200)), true); o += 2;
    v.setInt16(o, Math.round(clamp(e.y, -3200, 3200)), true); o += 2;
    v.setInt16(o, Math.round(clamp(e.v * 100, -32000, 32000)), true); o += 2;
  }
  return buf;
}
export function decodeFrame(buf) {
  const v = new DataView(buf);
  let o = 0;
  if (v.getUint8(o) !== 1) return null; o += 1;
  const f = { men: [], balls: [], fx: [] };
  f.phase = PHASES[v.getUint8(o)] || 'play'; o += 1;
  f.round = v.getUint16(o, true); o += 2;
  f.t = v.getFloat64(o, true); o += 8;
  f.score = [v.getUint8(o), v.getUint8(o + 1)]; o += 2;
  const clk = v.getUint16(o, true); o += 2;
  f.clock = clk === 0xffff ? -1 : clk / 10;
  f.golden = (v.getUint8(o) & 1) === 1; o += 1;
  const nm = v.getUint8(o), nb = v.getUint8(o + 1), nf = v.getUint8(o + 2); o += 3;
  for (let m = 0; m < nm; m++) {
    const man = { slot: v.getUint8(o), bits: v.getUint8(o + 1), p: new Float32Array(30) }; o += 2;
    for (let i = 0; i < 30; i += 3) {
      man.p[i] = v.getInt16(o, true) / 10; o += 2;
      man.p[i + 1] = v.getInt16(o, true) / 10; o += 2;
      man.p[i + 2] = v.getInt16(o, true) / 10000; o += 2;
    }
    f.men.push(man);
  }
  for (let b = 0; b < nb; b++) {
    f.balls.push({ x: v.getInt16(o, true) / 10, y: v.getInt16(o + 2, true) / 10, a: v.getInt16(o + 4, true) / 10000, bits: v.getUint8(o + 6) });
    o += 7;
  }
  for (let i = 0; i < nf; i++) {
    f.fx.push({ type: v.getUint8(o), x: v.getInt16(o + 1, true), y: v.getInt16(o + 3, true), v: v.getInt16(o + 5, true) / 100 });
    o += 7;
  }
  return f;
}
// effect codes carried inside snapshots (cosmetic, may be lost)
export const FX = { KICK: 1, BOUNCE: 2, POST: 3, NET: 4, HOP: 5, LAND: 6 };

/* ------------------------- sound -------------------------
   One AudioContext for the whole page, created on the first gesture.      */
export const Snd = {
  ctx: null, master: null, muted: false, noiseBuf: null, crowdSrc: null, crowdGain: null,
  unlock() {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { return; }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.85;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  setMuted(v) {
    this.muted = v;
    try { localStorage.setItem('cc-muted', v ? '1' : '0'); } catch (e) { }
    if (this.master) this.master.gain.setTargetAtTime(v ? 0 : 0.85, this.ctx.currentTime, 0.03);
  },
  ok() { return this.ctx && !this.muted && this.ctx.state === 'running'; },
  tone(f0, f1, dur, type, gain, delay) {
    if (!this.ok()) return;
    const c = this.ctx, t0 = c.currentTime + (delay || 0);
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t0);
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.03);
  },
  noise(dur, gain, type, hz, q, delay, attack) {
    if (!this.ok()) return;
    const c = this.ctx, t0 = c.currentTime + (delay || 0);
    if (!this.noiseBuf) {
      const n = c.sampleRate * 2, buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    const src = c.createBufferSource(); src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter(); f.type = type || 'lowpass'; f.frequency.value = hz || 1000; f.Q.value = q || 0.7;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + (attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0, Math.random()); src.stop(t0 + dur + 0.05);
  },
  kick(p) { const v = Math.min(1, p / 16); this.tone(150, 48, 0.12, 'sine', 0.25 + v * 0.3); this.noise(0.05, 0.08 + v * 0.12, 'bandpass', 1800, 1.2); },
  bounce(sp) { this.tone(240, 150, 0.07, 'triangle', Math.min(0.16, 0.03 + sp * 0.01)); },
  post(sp) { this.tone(1320, 1240, 0.35, 'triangle', Math.min(0.18, 0.05 + sp * 0.01)); this.tone(1980, 1900, 0.25, 'sine', 0.05); },
  net() { this.noise(0.18, 0.06, 'highpass', 2500, 0.5); },
  hop() { this.noise(0.06, 0.03, 'lowpass', 700, 0.7); },
  land() { this.tone(90, 50, 0.08, 'sine', 0.12); },
  beep(hi) { this.tone(hi ? 1040 : 660, hi ? 1040 : 660, hi ? 0.35 : 0.14, 'square', 0.05); },
  whistle() {
    if (!this.ok()) return;
    const c = this.ctx, t0 = c.currentTime;
    const o = c.createOscillator(), lfo = c.createOscillator(), lg = c.createGain(), g = c.createGain();
    o.type = 'square'; o.frequency.value = 2650;
    lfo.frequency.value = 38; lg.gain.value = 90;
    lfo.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.045, t0 + 0.02);
    g.gain.setValueAtTime(0.045, t0 + 0.22);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
    o.connect(g); g.connect(this.master);
    o.start(t0); lfo.start(t0); o.stop(t0 + 0.35); lfo.stop(t0 + 0.35);
  },
  goal() {
    this.noise(2.2, 0.32, 'bandpass', 900, 0.5, 0, 0.25);
    this.noise(1.6, 0.12, 'bandpass', 2400, 0.8, 0.1, 0.2);
    const n = [220, 277, 330, 440];
    for (let i = 0; i < n.length; i++) this.tone(n[i], n[i] * 1.01, 0.9, 'sawtooth', 0.035, 0.05);
  },
  ooh() { this.noise(0.9, 0.12, 'bandpass', 520, 1.4, 0.05, 0.15); },
  win() {
    const n = [523, 659, 784, 1046];
    for (let i = 0; i < n.length; i++) this.tone(n[i], n[i], 0.35, 'triangle', 0.12, i * 0.14);
    this.noise(2.5, 0.25, 'bandpass', 900, 0.5, 0, 0.3);
  },
  ui() { this.tone(620, 880, 0.08, 'triangle', 0.1); },
  crowdOn() {
    if (!this.ctx || this.crowdSrc) return;
    this.noise(0.01, 0.0002);
    if (!this.noiseBuf) return;
    const c = this.ctx, src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 480; f.Q.value = 0.5;
    const g = c.createGain(); g.gain.value = 0.0001;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start();
    g.gain.setTargetAtTime(0.035, c.currentTime, 0.8);
    this.crowdSrc = src; this.crowdGain = g;
  },
  crowdOff() {
    if (!this.crowdSrc) return;
    const src = this.crowdSrc, g = this.crowdGain, c = this.ctx;
    g.gain.setTargetAtTime(0.0001, c.currentTime, 0.3);
    setTimeout(() => { try { src.stop(); } catch (e) { } }, 1500);
    this.crowdSrc = null; this.crowdGain = null;
  }
};
if (typeof window !== 'undefined') {
  try { Snd.muted = localStorage.getItem('cc-muted') === '1'; } catch (e) { }
}

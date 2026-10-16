/* The sound: one AudioContext for the whole page, created on the first gesture.
   Browser only (the simulation in sim.js has none). */
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

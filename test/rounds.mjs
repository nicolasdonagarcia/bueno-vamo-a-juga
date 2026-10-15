// Every ball and every crazy round, drawn and played: CPU against CPU for a few
// seconds each in a real canvas. Checks there are no errors, the ball stays in
// play and keeps moving, the scoreboard names the round, and saves a picture of each.
//
//   NEXT_PUBLIC_BOTS=1 npm run build && npm start
//   node test/rounds.mjs              (BASE, CHROME, OUT, SECONDS=8)
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.OUT || 'test-results';
const SECONDS = Number(process.env.SECONDS || 8);
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ROUNDS = [
  ['football', { ball: 'normal' }, null],
  ['beach ball', { ball: 'beach' }, 'Beach ball'],
  ['rugby ball', { ball: 'rugby' }, 'Rugby ball'],
  ['American football', { ball: 'american' }, 'American football'],
  ['baseball', { ball: 'baseball' }, 'Baseball'],
  ['giant ball', { ball: 'giant' }, 'Giant ball'],
  ['tiny ball', { ball: 'tiny' }, 'Tiny ball'],
  ['balloon', { ball: 'balloon' }, 'Balloon'],
  ['moon gravity', { gravity: 0.62 }, 'Moon gravity'],
  ['heavy gravity', { gravity: 1.35 }, 'Heavy gravity'],
  ['ice pitch', { slippery: true }, 'Ice pitch'],
  ['bouncy pitch', { bouncy: true }, 'Bouncy pitch'],
  ['two balls', { twoBalls: true }, 'Two balls'],
  ['big heads', { bigHeads: true }, 'Big heads'],
  ['long legs', { longLegs: true }, 'Long legs'],
  ['big goals', { goalScale: 1.25 }, 'Big goals'],
  ['small goals', { goalScale: 0.8 }, 'Small goals'],
  ['everything at once', { ball: 'american', gravity: 0.62, slippery: true, twoBalls: true, bigHeads: true, longLegs: true, goalScale: 1.25 }, 'Two balls']
];

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage({ viewport: { width: 1060, height: 720 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await page.goto(BASE + '/');
await page.waitForFunction(() => !!window.__createGame, null, { timeout: 30000 });
await page.evaluate(() => {
  const div = document.createElement('div');
  div.id = 'rounds';
  div.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000';
  document.body.appendChild(div);
});

const results = [];
for (const [name, force, label] of ROUNDS) {
  const before = errors.length;
  const r = await page.evaluate(async ([force, seconds]) => {
    const host = document.getElementById('rounds');
    host.innerHTML = '<div class="arena" style="width:100%;height:100%"></div>';
    const g = window.__createGame(host.firstChild, { mode: 'practice', forceRound: force, cpuSkill: 0.85, rules: { goals: 99, capSec: 0, modifiers: true } });
    g.setBot(0.85);
    g.startMatch();
    const wait = ms => new Promise(r => setTimeout(r, ms));
    while (g.phase !== 'play') await wait(100);
    const t0 = performance.now(), track = [];
    let bad = '', maxBalls = 0;
    while (performance.now() - t0 < seconds * 1000) {
      await wait(250);
      const balls = g.debug.balls;
      maxBalls = Math.max(maxBalls, balls.length);
      for (const b of balls) if (!isFinite(b.position.x) || !isFinite(b.position.y)) bad = 'ball position ' + b.position.x + ',' + b.position.y;
      for (const c of g.debug.chars) for (const p of c.parts) if (!isFinite(p.position.x) || !isFinite(p.position.y)) bad = 'a man at NaN';
      if (balls[0]) track.push([balls[0].position.x, balls[0].position.y]);
    }
    let moved = 0;
    for (let i = 1; i < track.length; i++) moved += Math.hypot(track[i][0] - track[i - 1][0], track[i][1] - track[i - 1][1]);
    const mods = Array.from(document.querySelectorAll('#rounds .wc-mods span')).map(s => s.textContent);
    const out = { bad, moved: Math.round(moved), score: g.score, stats: JSON.parse(JSON.stringify(g.stats)), maxBalls, mods, phase: g.phase };
    window.__lastRound = g;
    return out;
  }, [force, SECONDS]);
  await page.screenshot({ path: OUT + '/round-' + name.replace(/\s+/g, '-').toLowerCase() + '.png' });
  await page.evaluate(() => { window.__lastRound.destroy(); });
  const problems = [];
  if (r.bad) problems.push(r.bad);
  if (r.moved < 200) problems.push('the ball hardly moved (' + r.moved + ' px)');
  if (label && !r.mods.includes(label)) problems.push('scoreboard shows ' + JSON.stringify(r.mods) + ', not ' + label);
  if (force.twoBalls && r.maxBalls !== 2) problems.push(r.maxBalls + ' balls');
  if (r.stats.respawns > 2) problems.push(r.stats.respawns + ' men respawned');
  if (errors.length > before) problems.push('page errors: ' + errors.slice(before).join(' | '));
  results.push([problems.length ? 'FAIL' : 'pass', name, 'ball travelled ' + r.moved + ' px, score ' + r.score.join('–') + ', re-drops ' + (r.stats.out.dead + r.stats.out.roof + r.stats.out.lost) + (problems.length ? ' · ' + problems.join('; ') : '')]);
  console.log(results[results.length - 1].join('  '));
}
await browser.close();
const failed = results.filter(r => r[0] !== 'pass').length;
console.log(failed ? failed + ' of ' + results.length + ' rounds failed' : 'all ' + results.length + ' rounds passed');
process.exit(failed ? 1 : 0);

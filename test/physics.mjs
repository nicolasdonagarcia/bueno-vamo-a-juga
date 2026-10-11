// How the men move and how matches go: CPU against CPU, simulated without
// drawing, several seeds. Needs a test build and Playwright:
//
//   NEXT_PUBLIC_BOTS=1 npm run build && npm start
//   node test/physics.mjs [seconds=120] [seeds=6] ['{"rockMax":0.6}'] ['{"ball":"american"}']
//   HOPS=1 node test/physics.mjs 0 4 ['{"rockMax":0.6}']     hops timed at the peak of the lean
//
// Reports goals and own goals a minute, how often men lie on the turf, and for
// strikers and keepers separately: jump height (px) and hop distance (px).
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const seconds = +(process.argv[2] || 120), seeds = +(process.argv[3] || 6);
const tune = process.argv[4] ? JSON.parse(process.argv[4]) : null;
const force = process.argv[5] ? JSON.parse(process.argv[5]) : null;
const skills = process.env.SKILLS ? JSON.parse(process.env.SKILLS) : [0.8, 0.8];

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(BASE + '/');
await page.waitForFunction(() => !!window.__createGame, null, { timeout: 30000 });
await page.evaluate(() => {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:280px;opacity:0;pointer-events:none';
  document.body.appendChild(div);
  window.__sim = window.__createGame(div, { mode: 'practice', renderEvery: 1e9, rules: { goals: 99, capSec: 0, modifiers: false } });
  window.__sim.setPaused(true);
});
// HOPS=1: every man presses at the peak of his lean, forward then back
if (process.env.HOPS) {
  for (const dir of [1, -1]) {
    const r = await page.evaluate(([t, d, n]) => window.__sim.debug.hops({ tune: t, dir: d, cycles: n }), [tune, dir, seeds * 10]);
    const f = x => `n ${x.n} p10 ${x.p10} p50 ${x.p50} p90 ${x.p90} wrong way ${x.wrongWay}`;
    console.log((dir > 0 ? 'forward ' : 'backward') + ' | striker ' + f(r.striker) + ' | keeper ' + f(r.keeper) + ' | down a second later ' + r.downAfter);
  }
  await browser.close();
  process.exit(0);
}
const runs = [];
for (let s = 1; s <= seeds; s++) {
  const r = await page.evaluate(([sec, seed, t, f, sk]) => window.__sim.debug.sim({ seconds: sec, seed: seed * 101, tune: t, force: f, skills: sk }), [seconds, s, tune, force, skills]);
  runs.push(r);
  const g = x => `jumps ${x.jumps} apex ${x.apexP50}/${x.apexP90} hop ${x.hopP50}/${x.hopP90} fwd ${x.fwdShare} back ${x.backShare}`;
  console.log(`seed ${s}: goals/min ${r.goalsPerMin} own ${r.ownGoalsPerMin} lying ${r.lying} air ${r.airborne} outs/min ${r.outsPerMin} | striker ${g(r.striker)} | keeper ${g(r.keeper)}`);
}
const mean = f => +(runs.reduce((a, r) => a + f(r), 0) / runs.length).toFixed(2);
console.log('\nmean over ' + seeds + ' seeds of ' + seconds + 's' + (tune ? ' with ' + JSON.stringify(tune) : '') + (force ? ' forcing ' + JSON.stringify(force) : ''));
console.log('  goals/min ' + mean(r => r.goalsPerMin) + '  own goals/min ' + mean(r => r.ownGoalsPerMin) + '  lying ' + mean(r => r.lying) +
  '  airborne ' + mean(r => r.airborne) + '  outs/min ' + mean(r => r.outsPerMin) + '  respawns ' + mean(r => r.respawns));
for (const k of ['striker', 'keeper']) {
  if (!runs.some(r => r[k].jumps)) continue;
  console.log('  ' + k.padEnd(8) + ' apex p50 ' + mean(r => r[k].apexP50) + ' p90 ' + mean(r => r[k].apexP90) + '  hop p50 ' + mean(r => r[k].hopP50) +
    ' p90 ' + mean(r => r[k].hopP90) + '  forward ' + mean(r => r[k].fwdShare) + ' back ' + mean(r => r[k].backShare));
}
console.log(errors.length ? 'page errors: ' + JSON.stringify(errors) : 'no page errors');
await browser.close();

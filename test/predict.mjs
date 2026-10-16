// The guest's prediction in every ball and crazy round: a host and a guest engine on one
// page, wired together through a pretend connection with a long delay (by default 75 ms
// each way plus up to 15 ms of jitter, about New Jersey to Buenos Aires). The CPU plays
// both sides; the guest's CPU presses through prediction like a person would. For each
// round it reports how often the guest's copy had exactly what the host had (no
// correction needed), how far its men had to slide when it didn't, and late presses.
//
//   NEXT_PUBLIC_BOTS=1 npm run build && npm start
//   node test/predict.mjs              (BASE, CHROME, SECONDS=10, LAG=75, JITTER=15)
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const SECONDS = Number(process.env.SECONDS || 10), LAG = Number(process.env.LAG || 75), JITTER = Number(process.env.JITTER || 15);

const ROUNDS = [
  ['football', { ball: 'normal' }],
  ['beach ball', { ball: 'beach' }],
  ['rugby ball', { ball: 'rugby' }],
  ['American football', { ball: 'american' }],
  ['baseball', { ball: 'baseball' }],
  ['giant ball', { ball: 'giant' }],
  ['tiny ball', { ball: 'tiny' }],
  ['balloon', { ball: 'balloon' }],
  ['moon gravity', { gravity: 0.62 }],
  ['heavy gravity', { gravity: 1.35 }],
  ['ice pitch', { slippery: true }],
  ['bouncy pitch', { bouncy: true }],
  ['two balls', { twoBalls: true }],
  ['big heads', { bigHeads: true }],
  ['long legs', { longLegs: true }],
  ['big goals', { goalScale: 1.25 }],
  ['small goals', { goalScale: 0.8 }],
  ['everything at once', { ball: 'american', gravity: 0.62, slippery: true, twoBalls: true, bigHeads: true, longLegs: true, goalScale: 1.25 }]
];

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
const page = await browser.newPage({ viewport: { width: 1060, height: 720 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(BASE + '/');
await page.waitForFunction(() => !!window.__createGame, null, { timeout: 30000 });

const results = [];
for (const [name, force] of ROUNDS) {
  const before = errors.length;
  const r = await page.evaluate(async ([force, seconds, lag, jitter]) => {
    document.getElementById('pred-test')?.remove();
    const box = document.createElement('div');
    box.id = 'pred-test';
    box.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000;display:grid;grid-template-columns:1fr 1fr';
    box.innerHTML = '<div class="arena"></div><div class="arena"></div>';
    document.body.appendChild(box);
    // a pretend connection: everything arrives lag..lag+jitter ms later, the reliable side in order
    const wire = () => { let at = 0; return (fn, ordered) => { let t = performance.now() + lag + Math.random() * jitter; if (ordered) { t = Math.max(t, at); at = t; } setTimeout(fn, t - performance.now()); }; };
    const toGuest = wire(), toHost = wire();
    let guest = null;
    const host = window.__createGame(box.children[0], { mode: 'host', forceRound: force, rules: { goals: 99, capSec: 0, modifiers: true }, sound: false, snapEvery: 2,
      hooks: {
        onSnapshot: buf => toGuest(() => guest && guest.pushSnapshot(buf), false),
        onFullState: buf => toGuest(() => guest && guest.pushSnapshot(buf), false),
        onEvent: ev => toGuest(() => guest && guest.applyRemoteEvent(ev), true),
        onPressAck: (q, sl) => toGuest(() => guest && guest.pressAck(q, sl), true),
        onHostPress: (s, n, l, r) => toGuest(() => guest && guest.hostPress(s, n, l, r), true)
      } });
    host.setViewDelay(0);
    guest = window.__createGame(box.children[1], { mode: 'guest', rules: { goals: 99, capSec: 0, modifiers: true }, sound: false,
      hooks: { onPress: (s, vt, n, q) => toHost(() => host.remotePress(s, vt, n, q), true) } });
    guest.setViewDelay(30);
    guest.setRtt(2 * lag + jitter);
    toGuest(() => guest.applySync(host.getSync()), true);
    host.setBot(0.85); guest.setBot(0.85);
    host.startMatch();
    const wait = ms => new Promise(r => setTimeout(r, ms));
    while (host.phase !== 'play') await wait(100);
    await wait(seconds * 1000);
    const p = guest.debug.pred;
    const out = { pred: p, score: host.score, stats: JSON.parse(JSON.stringify(host.stats)), guestBalls: guest.debug.balls.length, hostBalls: host.debug.balls.length };
    host.destroy(); guest.destroy();
    return out;
  }, [force, SECONDS, LAG, JITTER]);
  const p = r.pred, checks = p.same + Object.values(p.why).reduce((a, b) => a + b, 0);
  const sameShare = checks ? p.same / checks : 0;
  const problems = [];
  if (!p.on) problems.push('the guest never started predicting');
  if (sameShare < 0.5) problems.push('the copy matched the host only ' + Math.round(sameShare * 100) + '% of the time');
  // the guest's own men only slide when the host's side bumped into them or the ball
  if (p.ownCorrP50 > 6 || p.ownCorrP90 > 60) problems.push('the guest\'s own men slid ' + p.ownCorrP50 + ' px (median), ' + p.ownCorrP90 + ' px (one in ten)');
  if (p.late > 3) problems.push(p.late + ' late presses');
  if (r.guestBalls !== r.hostBalls) problems.push('the copy has ' + r.guestBalls + ' balls, the host ' + r.hostBalls);
  if (errors.length > before) problems.push('page errors: ' + errors.slice(before).join(' | '));
  results.push([problems.length ? 'FAIL' : 'pass', name, 'matched ' + Math.round(sameShare * 100) + '% of ' + checks + ' full states, ' + p.reconciles + ' re-runs of ' + p.resimAvg + ' ticks (' + p.costMs + ' ms), own men slid ' + p.ownCorrP50 + '/' + p.ownCorrP90 + ' px (median/one in ten), the host\'s ' + p.oppCorrP50 + '/' + p.oppCorrP90 + ' px, ' + p.acks + ' presses, ' + p.late + ' late, differed by ' + JSON.stringify(p.why) + (problems.length ? ' · ' + problems.join('; ') : '')]);
  console.log(results[results.length - 1].join('  '));
}
await browser.close();
const failed = results.filter(r => r[0] !== 'pass').length;
console.log(failed ? failed + ' of ' + results.length + ' rounds failed' : 'all ' + results.length + ' rounds predicted well');
process.exit(failed ? 1 : 0);

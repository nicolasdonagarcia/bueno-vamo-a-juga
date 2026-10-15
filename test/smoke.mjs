// Quick look at every page: loads, joins, starts, screenshots. Needs a running server.
//   BASE=http://localhost:3000 OUT=test-results/smoke node test/smoke.mjs
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.OUT || 'test-results/smoke';
import { mkdirSync } from 'fs';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
const problems = [];
function watch(page, name) {
  page.on('pageerror', e => problems.push(name + ' pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push(name + ' console: ' + m.text()); });
  page.on('response', r => { if (r.status() >= 400) problems.push(name + ' http ' + r.status() + ' ' + r.url()); });
}
const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const p = await desk.newPage(); watch(p, 'desk');
await p.goto(BASE + '/');
await p.waitForTimeout(1500);
await p.screenshot({ path: OUT + '/landing.png' });

await p.goto(BASE + '/new');
await p.getByRole('button', { name: 'Create the cup' }).click();
await p.waitForURL(/\/admin/);
await p.waitForTimeout(1500);
const code = p.url().split('/t/')[1].split('/')[0];
console.log('code', code, 'url after create', p.url());
await p.screenshot({ path: OUT + '/admin-lobby.png', fullPage: true });

const phones = [];
for (const [i, name] of ['Alice', 'Bob', 'Chidi'].entries()) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const pg = await ctx.newPage(); watch(pg, name);
  await pg.goto(BASE + '/t/' + code);
  await pg.getByLabel('Your name').fill(name);
  await pg.getByRole('button', { name: 'Join the cup' }).click();
  await pg.waitForSelector('text=You\'re in');
  phones.push(pg);
  if (i === 0) { await pg.waitForTimeout(800); await pg.screenshot({ path: OUT + '/phone-lobby.png', fullPage: true }); }
}
// the big screen is the organiser's: give that window the admin key this browser saved
const key = await p.evaluate(c => localStorage.getItem('cc:admin:' + c), code);
const big = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await big.addInitScript(([c, k]) => localStorage.setItem('cc:admin:' + c, k), [code, key]);
const sp = await big.newPage(); watch(sp, 'screen');
await sp.goto(BASE + '/t/' + code + '/screen');
await sp.waitForTimeout(2500);
await sp.screenshot({ path: OUT + '/screen-lobby.png' });

// start from the admin page
await p.reload();
await p.getByRole('button', { name: 'Make the draw and start' }).click();
await p.waitForSelector('text=Matches');
await p.waitForTimeout(1000);
await p.screenshot({ path: OUT + '/admin-running.png', fullPage: true });
await phones[0].waitForTimeout(2500);
await phones[0].screenshot({ path: OUT + '/phone-running.png', fullPage: true });
await sp.waitForTimeout(2000);
await sp.screenshot({ path: OUT + '/screen-running.png' });
const pr = await desk.newPage(); watch(pr, 'practice');
await pr.goto(BASE + '/practice');
await pr.waitForTimeout(1200);
await pr.screenshot({ path: OUT + '/practice.png' });
console.log(JSON.stringify({ code, problems }, null, 1));
await browser.close();

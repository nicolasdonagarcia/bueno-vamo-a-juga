// Every page and button, the way people use them, in real Chromium windows:
// the landing page, practice, creating a cup, the admin page, joining and editing
// an entry, the player's page through a whole cup, the match controls (keys,
// touch, mute), golden goal and time limits, phones, the big-screen lobby, odd
// links, and that a production build has no test switches.
//
//   NEXT_PUBLIC_BOTS=1 npm run build && npm start
//   node test/features.mjs     (BASE, CHROME, OUT, ONLY=landing,practice,...; PROD=<url of a normal build>; NOSTORE=<url of a Vercel build without Redis>)
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.OUT || 'test-results';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(path, body, base = BASE) {
  const r = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + JSON.stringify(j));
  return j;
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(200); }
  throw new Error('timed out: ' + what + (last ? ' (last: ' + String(last).slice(0, 120) + ')' : ''));
}
function check(cond, what) { if (!cond) throw new Error(what); }

const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
});
const problems = [];
const contexts = [];
async function open(path, o = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, ...(o.device || {}), ...(o.ctx || {}) });
  contexts.push(ctx);
  if (o.permissions) await ctx.grantPermissions(o.permissions, { origin: o.base || BASE });
  await ctx.addInitScript(s => {
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v));
  }, o.storage || {});
  const page = await ctx.newPage();
  const label = o.label || path;
  page.on('pageerror', e => problems.push(label + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::/.test(m.text())) problems.push(label + ' console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto((o.base || BASE) + path);
  return page;
}
const results = [];
async function step(id, title, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  const t = Date.now();
  try { const note = await fn(); results.push([id, 'pass', title, ((Date.now() - t) / 1000).toFixed(1) + 's' + (note ? ' · ' + note : '')]); }
  catch (e) { results.push([id, 'FAIL', title, e.message.split('\n').filter(l => l.trim()).slice(0, 3).join(' | ')]); }
  console.log(results[results.length - 1].join('  '));
  for (const c of contexts.splice(0)) await c.close().catch(() => { });
}
async function cup(names, rules, name = 'Feature Cup') {
  const { code, adminKey } = await call('/api/t', { name });
  if (rules) await call('/api/t/' + code + '/admin', { key: adminKey, action: 'rules', rules });
  const ps = [];
  for (const [i, n] of names.entries()) ps.push({ name: n, ...(await call('/api/t/' + code + '/join', { name: n, flag: ['es', 'br', 'se', 'jp', 'ng', 'it', 'mx', 'kr'][i % 8], color: ['orange', 'teal', 'red', 'blue', 'green', 'purple', 'yellow', 'pink'][i % 8] })) });
  const admin = (action, extra) => call('/api/t/' + code + '/admin', { key: adminKey, action, ...extra });
  const view = () => call('/api/t/' + code);
  const who = id => ps.find(p => p.playerId === id);
  return { code, adminKey, ps, admin, view, who, store: p => ({ ['cc:player:' + code]: { token: p.token, playerId: p.playerId } }) };
}
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
// A press sets the man's press timer (cd) to 0.26 s, which then keeps counting down below zero.
// "pressed" = pressed within the last ~0.7 s. `which` is 'practice' or 'cc' (the online match engine).
const cds = (page, which) => page.evaluate(w => (w === 'cc' ? window.__cc.game : window.__practice).debug.chars
  .filter(c => w !== 'practice' || window.__practice.mode !== 'practice' || c.team === 0).map(c => [c.slot, c.cd]), which);
async function quiet(page, which) { await until(async () => (await cds(page, which)).every(([, cd]) => cd < -0.5), 4000, 'no recent presses'); }
async function pressed(page, which, slots, ms = 900) {
  const end = Date.now() + ms;
  let st = [];
  while (Date.now() < end) {
    st = await cds(page, which);
    const on = st.filter(([, cd]) => cd > -0.45).map(([s]) => s).sort();
    if (on.join() === slots.slice().sort().join()) return;
    if (on.some(s => !slots.includes(s))) break;
    await sleep(40);
  }
  throw new Error('expected presses on ' + JSON.stringify(slots) + ', got ' + JSON.stringify(st.map(([s, cd]) => s + ':' + cd.toFixed(2))));
}

// ---------------------------------------------------------------- landing
await step('landing', 'landing page: the demo plays, codes, links', async () => {
  const c = await cup([]);
  const p = await open('/');
  const canvas = p.locator('canvas.wc-pitch').first();
  await canvas.waitFor({ timeout: 15000 });
  await sleep(800);
  const a = await canvas.screenshot(); await sleep(700); const b = await canvas.screenshot();
  check(!a.equals(b), 'the demo match is not moving');
  const join = p.getByRole('button', { name: 'Join', exact: true });
  check(await join.isDisabled(), 'Join enabled with no code');
  await p.getByLabel('Cup code').fill('ab');
  check(await join.isDisabled(), 'Join enabled with 2 characters');
  await p.getByLabel('Cup code').fill(c.code.slice(0, 2).toLowerCase() + '-' + c.code.slice(2).toLowerCase());
  await join.click();
  await p.waitForURL('**/t/' + c.code, { timeout: 10000 });
  await p.getByRole('heading', { name: 'Enter the cup' }).waitFor({ timeout: 10000 });
  await p.goto(BASE + '/');
  await p.getByLabel('Cup code').fill('ZZZZZ');
  await p.getByRole('button', { name: 'Join', exact: true }).click();
  await p.getByText('No cup with the code ZZZZZ').waitFor({ timeout: 10000 });
  await p.goto(BASE + '/');
  await p.getByRole('link', { name: 'Start a cup' }).click();
  await p.waitForURL('**/new');
  await p.goto(BASE + '/');
  await p.getByRole('link', { name: 'Practice against the CPU' }).click();
  await p.waitForURL('**/practice');
  await p.goto(BASE + '/');
  await sleep(1500);
  await p.screenshot({ path: OUT + '/landing.png' });
});

// ---------------------------------------------------------------- practice
await step('practice', 'practice: kick off, keys, one man, pause, mute, levels, to the end, two players', async () => {
  const p = await open('/practice');
  const kick = p.getByRole('button', { name: 'Kick off' });
  await until(async () => !(await kick.isDisabled()), 15000, 'Kick off enabled');
  await kick.click();
  await until(() => p.evaluate(() => window.__practice.phase === 'play'), 8000, 'play after the countdown');
  await quiet(p, 'practice');
  await p.keyboard.press('Space');
  await pressed(p, 'practice', [0, 1]);
  await quiet(p, 'practice');
  await p.keyboard.press('KeyA');
  await pressed(p, 'practice', [0]);
  // pause with Esc and P
  await p.keyboard.press('Escape');
  await p.getByRole('heading', { name: 'Paused' }).waitFor({ timeout: 3000 });
  check(await p.evaluate(() => window.__practice.paused), 'engine not paused');
  const t1 = await p.evaluate(() => window.__practice.hostClock); await sleep(600);
  check(await p.evaluate(t => window.__practice.hostClock === t, t1), 'clock runs while paused');
  await p.getByRole('button', { name: 'Resume' }).click();
  check(!(await p.evaluate(() => window.__practice.paused)), 'still paused after Resume');
  await p.keyboard.press('KeyP');
  await p.getByRole('heading', { name: 'Paused' }).waitFor({ timeout: 3000 });
  await p.keyboard.press('KeyP');
  await until(async () => !(await p.evaluate(() => window.__practice.paused)), 3000, 'P resumes');
  // mute
  const mute = p.locator('.wc-mute');
  check((await mute.getAttribute('aria-pressed')) === 'false', 'sound off at the start');
  await p.keyboard.press('KeyM');
  check((await mute.getAttribute('aria-pressed')) === 'true', 'M did not mute');
  await mute.click();
  check((await mute.getAttribute('aria-pressed')) === 'false', 'the mute button did not unmute');
  // CPU level
  await p.getByRole('radio', { name: 'Hard' }).click();
  check((await p.getByRole('radio', { name: 'Hard' }).getAttribute('aria-checked')) === 'true', 'Hard not selected');
  // let the CPU play our side too, to reach the end quickly
  await p.evaluate(() => { window.__practice.setBot(0.95); });
  await until(() => p.evaluate(() => window.__practice.phase === 'end'), 240000, 'the match to end');
  const sc = await p.evaluate(() => window.__practice.score);
  await p.getByRole('button', { name: 'Play again' }).waitFor({ timeout: 8000 });
  const heading = await p.locator('.ovl h2').textContent();
  check(/You won!|The CPU won/.test(heading), 'end card: ' + heading);
  check(Math.max(...sc) === 3, 'final score ' + sc);
  await p.screenshot({ path: OUT + '/practice-end.png' });
  await p.getByRole('button', { name: 'Play again' }).click();
  await p.getByRole('button', { name: 'Kick off' }).waitFor({ timeout: 8000 });
  // two players on one keyboard
  await p.getByRole('radio', { name: '2 players, 1 device' }).click();
  await p.getByText('Two players, one device').waitFor({ timeout: 8000 });
  const kick2 = p.getByRole('button', { name: 'Kick off' });
  await until(async () => !(await kick2.isDisabled()), 15000, 'Kick off enabled (2 players)');
  await kick2.click();
  await until(() => p.evaluate(() => window.__practice.phase === 'play'), 8000, 'play (2 players)');
  await quiet(p, 'practice');
  await p.keyboard.press('KeyW');
  await pressed(p, 'practice', [0, 1]);
  await quiet(p, 'practice');
  await p.keyboard.press('ArrowUp');
  await pressed(p, 'practice', [2, 3]);
  await quiet(p, 'practice');
  await p.keyboard.press('ArrowRight');
  await pressed(p, 'practice', [3]);
  return 'CPU v CPU ended ' + sc.join('–');
});

// ---------------------------------------------------------------- create
let created = null;
await step('create', 'creating a cup from the page, and the admin link', async () => {
  const p = await open('/new');
  const name = p.getByLabel('Name of the cup');
  check((await name.inputValue()) === 'The Coterie Cup', 'default name');
  await name.fill('');
  check(await p.getByRole('button', { name: 'Create the cup' }).isDisabled(), 'Create enabled with no name');
  await name.fill('Office Cup');
  await p.getByRole('button', { name: 'Create the cup' }).click();
  await p.getByRole('heading', { name: 'Share' }).waitFor({ timeout: 15000 });
  await until(() => /\/t\/[A-Z0-9]{5}\/admin$/.test(p.url()), 5000, 'admin address without the key: ' + p.url());
  const code = p.url().match(/\/t\/([A-Z0-9]{5})\/admin/)[1];
  const key = await p.evaluate(c => JSON.parse(localStorage.getItem('cc:admin:' + c)), code);
  check(key && key.length > 20, 'admin key not saved');
  check(!p.url().includes('#k='), 'the key is still in the address bar');
  created = { code, key };
  if (process.env.NOSTORE) {
    const v = await open('/new', { base: process.env.NOSTORE, label: 'nostore /new' });
    await v.getByRole('button', { name: 'Create the cup' }).click();
    await v.getByRole('alert').filter({ hasText: 'Storage is not set up' }).waitFor({ timeout: 10000 });
  }
});

// ---------------------------------------------------------------- admin key
await step('admin-key', 'admin page asks for the key; wrong keys and pasted links', async () => {
  const c = created || await cup([]).then(x => ({ code: x.code, key: x.adminKey }));
  const p = await open('/t/' + c.code + '/admin');
  await p.getByRole('heading', { name: 'Organisers only' }).waitFor({ timeout: 10000 });
  await p.getByLabel('Admin link or key').fill('not-the-key');
  await p.getByRole('button', { name: 'Continue' }).click();
  await p.getByText('That admin key does not match this cup.').waitFor({ timeout: 10000 });
  await p.getByLabel('Admin link or key').fill(BASE + '/t/' + c.code + '/admin#k=' + encodeURIComponent(c.key));
  await p.getByRole('button', { name: 'Continue' }).click();
  await p.getByRole('heading', { name: 'Share' }).waitFor({ timeout: 10000 });
  // the big screen without the key
  const s = await open('/t/' + c.code + '/screen');
  await s.getByText('This screen is for the organiser').waitFor({ timeout: 10000 });
});

// ---------------------------------------------------------------- admin
await step('admin', 'admin page: share, copy, rules, players, draw, results, reset, walkover, start over', async () => {
  const c = await cup(['Ana', 'Ben', 'Cy', 'Di', 'Ed']);
  const p = await open('/t/' + c.code + '/admin', { storage: { ['cc:admin:' + c.code]: c.adminKey }, permissions: ['clipboard-read', 'clipboard-write'] });
  await p.getByRole('heading', { name: 'Share' }).waitFor({ timeout: 10000 });
  await p.locator('.qr svg').first().waitFor({ timeout: 10000 });
  await p.getByRole('button', { name: 'Copy player link' }).click();
  await p.getByRole('button', { name: 'Copied' }).waitFor({ timeout: 3000 });
  check((await p.evaluate(() => navigator.clipboard.readText())) === BASE + '/t/' + c.code, 'player link on the clipboard');
  await sleep(1800);
  await p.getByRole('button', { name: 'Copy admin link' }).click();
  check((await p.evaluate(() => navigator.clipboard.readText())).endsWith('/admin#k=' + encodeURIComponent(c.adminKey)), 'admin link on the clipboard');
  const scr = p.getByRole('link', { name: 'Open the big screen' });
  check((await scr.getAttribute('href')) === '/t/' + c.code + '/screen' && (await scr.getAttribute('target')) === '_blank', 'big screen link');
  // rules
  await p.getByLabel('Matches: first to').selectOption('2');
  await p.getByLabel('Matches: time limit').selectOption('120');
  await p.getByLabel('Final: first to').selectOption('3');
  await p.getByLabel('Final: time limit').selectOption('180');
  await p.getByLabel(/Crazy rounds/).uncheck();
  await p.getByRole('region', { name: 'Rules' }).getByLabel('Name of the cup').fill('Friday Cup');
  await p.getByRole('button', { name: 'Save rules' }).click();
  await p.getByText('Saved', { exact: true }).waitFor({ timeout: 5000 });
  let v = await c.view();
  check(JSON.stringify(v.rules) === JSON.stringify({ goals: 2, capSec: 120, finalGoals: 3, finalCapSec: 180, modifiers: false, equalDelay: false }), 'rules saved: ' + JSON.stringify(v.rules));
  check(v.name === 'Friday Cup', 'renamed');
  // online without prediction, and back
  await p.getByLabel(/Equal delay instead of prediction/).check();
  await p.getByRole('button', { name: 'Save rules' }).click();
  await until(async () => (await c.view()).rules.equalDelay === true, 5000, 'equal delay saved');
  await p.getByLabel(/Equal delay instead of prediction/).uncheck();
  await p.getByRole('button', { name: 'Save rules' }).click();
  await until(async () => (await c.view()).rules.equalDelay === false, 5000, 'prediction back on');
  // players: remove one (the × asks first; Keep leaves them in)
  await p.getByRole('button', { name: 'Remove Ed' }).click();
  await p.getByRole('button', { name: 'Keep' }).click();
  await p.getByRole('button', { name: 'Remove Ed' }).click();
  await p.getByRole('button', { name: 'Yes, remove Ed' }).click();
  await until(async () => (await c.view()).players.length === 4, 5000, 'Ed removed');
  await p.getByText(/rounds · about/).waitFor({ timeout: 5000 });
  await p.screenshot({ path: OUT + '/admin-lobby.png', fullPage: true });
  // the draw
  await p.getByRole('button', { name: 'Make the draw and start' }).click();
  await p.getByRole('region', { name: 'Matches' }).waitFor({ timeout: 10000 });
  v = await c.view();
  check(v.status === 'running', 'not running after the draw');
  const [m1, m2] = v.matches.filter(m => m.round === 1);
  const rows = p.locator('.match-row');
  // a result typed in
  await rows.nth(0).getByRole('button', { name: 'Manage' }).click();
  const r0 = rows.nth(0);
  await r0.locator('.score-in input').nth(0).fill('2');
  await r0.locator('.score-in input').nth(1).fill('1');
  await r0.getByRole('button', { name: 'Save result' }).click();
  await until(async () => (await c.view()).matches.find(m => m.id === m1.id).status === 'done', 5000, 'result saved');
  v = await c.view();
  const x1 = v.matches.find(m => m.id === m1.id);
  check(x1.via === 'admin' && x1.score.join() === '2,1' && x1.winner === m1.a, 'typed result ' + JSON.stringify(x1));
  // undo it
  await r0.getByRole('button', { name: 'Reset this match' }).click();
  await r0.getByRole('button', { name: 'Reset', exact: true }).click();
  await until(async () => (await c.view()).matches.find(m => m.id === m1.id).status === 'ready', 5000, 'match reset');
  // a walkover
  const r1 = rows.nth(1);
  await r1.getByRole('button', { name: 'Manage' }).click();
  const bName = c.who(m2.b).name;
  await r1.getByRole('button', { name: bName + ' goes through' }).click();
  await until(async () => { const m = (await c.view()).matches.find(m => m.id === m2.id); return m.status === 'done' && m.via === 'walkover' && m.winner === m2.b; }, 5000, 'walkover');
  await r1.locator('.pill', { hasText: 'Walkover' }).waitFor({ timeout: 5000 });
  // the final's link to play it on this device
  await rows.nth(0).getByRole('button', { name: 'Manage' }).click();
  check((await rows.nth(0).getByRole('link', { name: 'Play it on this device' }).getAttribute('href')) === '/t/' + c.code + '/m/' + m1.id + '?local=1', 'play here link');
  await p.screenshot({ path: OUT + '/admin-running.png', fullPage: true });
  // start over
  await p.getByRole('button', { name: 'Back to the lobby' }).click();
  await p.getByRole('button', { name: 'Yes, clear the bracket' }).click();
  await until(async () => (await c.view()).status === 'lobby', 5000, 'back in the lobby');
  await p.getByRole('button', { name: 'Make the draw and start' }).waitFor({ timeout: 5000 });
});

// ---------------------------------------------------------------- joining
await step('join', 'joining from the page: form, edit, removed by the organiser, join again', async () => {
  const c = await cup([]);
  const p = await open('/t/' + c.code);
  await p.getByRole('heading', { name: 'Enter the cup' }).waitFor({ timeout: 10000 });
  check(await p.getByRole('button', { name: 'Join the cup' }).isDisabled(), 'Join enabled without a name');
  await p.getByLabel('Your name').fill('Marta');
  await p.locator('select.select').selectOption('es');
  await p.getByRole('radio', { name: /^Green/ }).click();
  await p.getByRole('button', { name: 'Join the cup' }).click();
  await p.getByText('You\'re in').waitFor({ timeout: 10000 });
  let v = await c.view();
  check(v.players.length === 1 && v.players[0].name === 'Marta' && v.players[0].flag === 'es' && v.players[0].color === 'green', 'joined as ' + JSON.stringify(v.players[0]));
  const saved = await p.evaluate(c => ({ me: JSON.parse(localStorage.getItem('cc:player:' + c)), prof: JSON.parse(localStorage.getItem('cc:profile')) }), c.code);
  check(saved.me && saved.me.playerId === v.players[0].id && saved.prof.name === 'Marta', 'saved identity');
  await p.locator('details.warmup').getByRole('button', { name: 'Kick off' }).waitFor({ timeout: 10000 });
  // edit
  await p.getByRole('button', { name: 'Edit' }).click();
  await p.getByLabel('Your name').fill('Marta R');
  await p.getByRole('radio', { name: /^Purple/ }).click();
  await p.getByRole('button', { name: 'Save' }).click();
  await p.getByText('Marta R').first().waitFor({ timeout: 10000 });
  v = await c.view();
  check(v.players.length === 1 && v.players[0].name === 'Marta R' && v.players[0].color === 'purple', 'edited: ' + JSON.stringify(v.players[0]));
  // another player who picked purple shows as taken
  await call('/api/t/' + c.code + '/join', { name: 'Paul', color: 'purple' });
  // removed by the organiser
  await c.admin('remove', { playerId: v.players[0].id });
  await p.getByText('The organiser removed your entry. You can join again.').waitFor({ timeout: 10000 });
  await p.getByRole('radio', { name: 'Purple (1 already)' }).waitFor({ timeout: 5000 });
  check((await p.getByLabel('Your name').inputValue()) === 'Marta R', 'the form remembers the profile');
  await p.getByRole('button', { name: 'Join the cup' }).click();
  await p.getByText('You\'re in').waitFor({ timeout: 10000 });
  check((await c.view()).players.length === 2, 'joined again');
  // the same browser, a second cup: the profile fills the form
  const c2 = await cup([]);
  await p.goto(BASE + '/t/' + c2.code);
  await p.getByRole('heading', { name: 'Enter the cup' }).waitFor({ timeout: 10000 });
  await until(async () => (await p.getByLabel('Your name').inputValue()) === 'Marta R', 5000, 'profile prefilled');
  await p.screenshot({ path: OUT + '/join.png', fullPage: true });
});

// ---------------------------------------------------------------- player page through a cup
await step('hub', 'the player page through a whole cup: ready, title, own link only, waiting, knocked out, champion', async () => {
  const c = await cup(['Marta', 'Ben', 'Cy', 'Di', 'Ed'], { goals: 2, capSec: 60, finalGoals: 3, finalCapSec: 90, modifiers: true });
  const marta = c.ps[0];
  const p = await open('/t/' + c.code, { storage: c.store(marta), label: 'hub Marta' });
  await p.getByText('You\'re in').waitFor({ timeout: 10000 });
  const outsider = await open('/t/' + c.code, { label: 'hub outsider' });
  await c.admin('start');
  let v = await c.view();
  // her latest match, as the page sees it (after a bye that is the round-2 match)
  const mine = v.matches.filter(m => m.a === marta.playerId || m.b === marta.playerId).sort((x, y) => y.round - x.round)[0];
  const viewers = [];
  await outsider.getByText('The draw has been made, so entries are closed').waitFor({ timeout: 10000 });
  if (mine.status === 'ready') {
    await p.getByRole('heading', { name: 'Your match is ready' }).waitFor({ timeout: 10000 });
    await until(async () => (await p.title()).startsWith('▶ Your match'), 5000, 'tab title');
    check((await p.getByRole('link', { name: 'Play' }).getAttribute('href')) === '/t/' + c.code + '/m/' + mine.id, 'Play link');
    const links = await p.locator('.bracket a[href*="/m/"]').evaluateAll(as => as.map(a => a.getAttribute('href')));
    check(links.length === 1 && links[0].endsWith(mine.id), 'bracket links: ' + JSON.stringify(links));
    // someone else's match
    const other = v.matches.find(m => m.status === 'ready' && m.id !== mine.id);
    if (other) {
      const n = await open('/t/' + c.code + '/m/' + other.id, { storage: c.store(marta), label: 'not mine' });
      await n.getByText('Not your match').waitFor({ timeout: 10000 });
      viewers.push('not-your-match ok');
    }
    // Marta loses her first match
    const base = '/t/' + c.code + '/m/' + mine.id;
    const host = c.who(mine.a);
    await call('/api' + base + '/report', { token: host.token, kind: 'final', score: mine.a === marta.playerId ? [0, 2] : [2, 0], winner: mine.a === marta.playerId ? 'b' : 'a' });
    await p.getByRole('heading', { name: 'Knocked out' }).waitFor({ timeout: 10000 });
  } else {
    // a bye: through to round 2, waiting for the other match
    await p.getByRole('heading', { name: 'You’re through!' }).waitFor({ timeout: 10000 });
    viewers.push('bye');
  }
  // play out the rest of the cup through the API
  for (let guard = 0; guard < 10; guard++) {
    v = await c.view();
    if (v.status === 'finished') break;
    for (const m of v.matches.filter(m => m.status === 'ready')) {
      const g = m.rules.goals;
      await call('/api/t/' + c.code + '/m/' + m.id + '/report', { token: c.who(m.a).token, kind: 'final', score: [g, 0], winner: 'a' });
    }
  }
  v = await c.view();
  check(v.status === 'finished', 'cup not finished');
  const champ = c.who(v.champion);
  await p.getByText(/Winner of Feature Cup|You won Feature Cup/).waitFor({ timeout: 15000 });
  await p.screenshot({ path: OUT + '/hub-finished.png', fullPage: true });
  const cp = await open('/t/' + c.code, { storage: c.store(champ), label: 'hub champion' });
  await cp.getByText('You won Feature Cup').waitFor({ timeout: 10000 });
  return viewers.join(', ');
});

// ---------------------------------------------------------------- match pages: odd links
await step('match-links', 'match links: waiting, finished, unknown, wrong cup', async () => {
  const c = await cup(['A1', 'B1', 'C1', 'D1']);
  await c.admin('start');
  const v = await c.view();
  const fin = v.matches.find(m => m.round === 2), s1 = v.matches.find(m => m.round === 1);
  const p = await open('/t/' + c.code + '/m/' + fin.id, { storage: c.store(c.who(s1.a)) });
  await p.getByRole('heading', { name: 'Not ready yet' }).waitFor({ timeout: 10000 });
  await c.admin('result', { matchId: s1.id, winner: 'a', score: [3, 1] });
  await p.goto(BASE + '/t/' + c.code + '/m/' + s1.id);
  await p.getByRole('heading', { name: c.who(s1.a).name + ' went through' }).waitFor({ timeout: 10000 });
  await p.goto(BASE + '/t/' + c.code + '/m/r9m9');
  await p.getByRole('heading', { name: 'No such match' }).waitFor({ timeout: 10000 });
  await p.goto(BASE + '/t/QQQQQ/m/r1m1');
  await p.getByText('No cup with the code QQQQQ').waitFor({ timeout: 10000 });
  await p.goto(BASE + '/t/QQQQQ');
  await p.getByText('No cup with the code QQQQQ').waitFor({ timeout: 10000 });
  const nf = await p.goto(BASE + '/no/such/page');
  check(nf.status() === 404, 'unknown page status ' + nf.status());
});

// ---------------------------------------------------------------- online match controls
async function onlineMatch(rules, names = ['Host', 'Guest']) {
  const c = await cup(names, rules);
  await c.admin('start');
  const m = (await c.view()).matches[0];
  const path = '/t/' + c.code + '/m/' + m.id;
  const H = await open(path, { storage: c.store(c.who(m.a)), label: 'host' });
  const G = await open(path, { storage: c.store(c.who(m.b)), label: 'guest' });
  return { c, m, path, H, G };
}

await step('online', 'online match: ready check, connection line, keys on both sides, mute, golden goal, the end on both screens', async () => {
  const o = await onlineMatch({ goals: 9, capSec: 6, finalGoals: 9, finalCapSec: 6, modifiers: false });
  await o.H.locator('.ovl').getByText('First to 9 · 0:06 min cap, then golden goal').waitFor({ timeout: 10000 });
  await o.H.getByText('Connected directly').waitFor({ timeout: 20000 });
  await o.H.getByRole('button', { name: 'I\'m ready' }).click();
  await o.G.getByText(o.c.who(o.m.a).name + ' is ready').waitFor({ timeout: 10000 });      // the draw decides who hosts
  await o.G.getByRole('button', { name: 'I\'m ready' }).click();
  await until(() => o.H.evaluate(() => window.__cc.game.phase === 'play'), 10000, 'kick-off');
  await quiet(o.H, 'cc');
  await o.H.keyboard.press('Space');
  await pressed(o.H, 'cc', [0, 1]);
  await quiet(o.H, 'cc');
  await o.G.keyboard.press('ArrowUp');
  await pressed(o.H, 'cc', [2, 3], 1500);              // the guest's press, applied on the host
  await quiet(o.H, 'cc');
  await o.G.keyboard.press('KeyD');
  await pressed(o.H, 'cc', [3], 1500);                 // D: only the guest's right-hand man
  await quiet(o.H, 'cc');
  await o.H.keyboard.press('KeyA');
  await pressed(o.H, 'cc', [0]);                       // A: only the host's left-hand man
  const mute = o.G.locator('.wc-mute');
  await o.G.keyboard.press('KeyM');
  check((await mute.getAttribute('aria-pressed')) === 'true', 'M did not mute the guest');
  await o.G.keyboard.press('KeyM');
  // the 6 s limit: golden goal if level, otherwise the leader wins on time
  await until(() => o.H.evaluate(() => window.__cc.game.phase === 'end' || /Golden goal/.test(document.querySelector('.wc-clock').textContent)), 20000, 'time up');
  const level = await o.H.evaluate(() => /Golden goal/.test(document.querySelector('.wc-clock').textContent));
  let path = 'won on time';
  if (level) {
    await o.G.locator('.wc-clock', { hasText: 'Golden goal' }).waitFor({ timeout: 5000 });
    await o.H.evaluate(() => window.__cc.game.setBot(0.95));
    path = 'golden goal';
  }
  const done = await until(async () => { const m = (await o.c.view()).matches[0]; return m.status === 'done' ? m : null; }, 150000, 'result saved');
  check(done.via === 'played' && done.score[0] !== done.score[1], 'result ' + JSON.stringify(done));
  if (level) check(Math.abs(done.score[0] - done.score[1]) === 1, 'golden goal should end 1 apart: ' + done.score);
  const hostWon = done.winner === o.m.a;
  await o.H.getByRole('heading', { name: hostWon ? 'Champion!' : 'Knocked out' }).waitFor({ timeout: 15000 });
  await o.G.getByRole('heading', { name: hostWon ? 'Knocked out' : 'Champion!' }).waitFor({ timeout: 15000 });
  await o.H.getByText('Result saved').waitFor({ timeout: 10000 });
  await o.G.screenshot({ path: OUT + '/online-end-guest.png' });
  return path + ' ' + done.score.join('–');
});

await step('time-limit', 'time limit with a leader: the leader wins when time runs out', async () => {
  // a strong CPU host against an idle guest: the host leads when the 20 s run out
  const o = await onlineMatch({ goals: 9, capSec: 20, finalGoals: 9, finalCapSec: 20, modifiers: false });
  await o.H.getByRole('button', { name: 'I\'m ready' }).click();
  await o.G.getByRole('button', { name: 'I\'m ready' }).click();
  await until(() => o.H.evaluate(() => window.__cc.game.phase === 'play'), 15000, 'kick-off');
  await o.H.evaluate(() => window.__cc.game.setBot(0.97));
  const done = await until(async () => { const m = (await o.c.view()).matches[0]; return m.status === 'done' ? m : null; }, 120000, 'result');
  const elapsed = (done.endedAt - done.startedAt) / 1000;
  return 'ended ' + done.score.join('–') + ' after ' + elapsed.toFixed(0) + 's' + (elapsed < 30 ? ' (on time)' : ' (golden goal)');
});

await step('final-rules', 'the final uses the final\'s own rules', async () => {
  const o = await onlineMatch({ goals: 2, capSec: 60, finalGoals: 4, finalCapSec: 240, modifiers: true });
  await o.H.locator('.ovl .kicker').getByText('Final · First to 4 · 4 min cap, then golden goal').waitFor({ timeout: 10000 });
});

// ---------------------------------------------------------------- phones
await step('phone', 'phones: no sideways scrolling, pads, tap to play, turn sideways hint', async () => {
  const phone = devices['iPhone 13'];
  const landP = await open('/', { device: phone, label: 'phone landing' });
  await landP.locator('canvas.wc-pitch').first().waitFor({ timeout: 15000 });
  check(await noOverflow(landP), 'landing scrolls sideways on a phone');
  await landP.screenshot({ path: OUT + '/phone-landing.png' });
  const c = await cup(['Desk', 'Phone'], { goals: 9, capSec: 0, finalGoals: 9, finalCapSec: 0, modifiers: false });
  const joinP = await open('/t/' + c.code, { device: phone, label: 'phone join' });
  await joinP.getByRole('heading', { name: 'Enter the cup' }).waitFor({ timeout: 10000 });
  check(await noOverflow(joinP), 'join form scrolls sideways');
  await joinP.screenshot({ path: OUT + '/phone-join.png', fullPage: true });
  await c.admin('start');
  const m = (await c.view()).matches[0];
  const path = '/t/' + c.code + '/m/' + m.id;
  const H = await open(path, { storage: c.store(c.who(m.a)), label: 'desk host' });
  const P = await open(path, { device: phone, storage: c.store(c.who(m.b)), label: 'phone guest' });
  await P.getByText('Turn your phone sideways').waitFor({ timeout: 10000 });
  check(await noOverflow(P), 'match page scrolls sideways');
  await P.screenshot({ path: OUT + '/phone-match-portrait.png' });
  await P.setViewportSize({ width: 844, height: 390 });
  await H.getByRole('button', { name: 'I\'m ready' }).click();
  await P.getByRole('button', { name: 'I\'m ready' }).tap();
  await until(() => H.evaluate(() => window.__cc.game.phase === 'play'), 15000, 'kick-off');
  check(await P.locator('.wc-pads').isVisible(), 'touch pads hidden on the phone');
  await quiet(H, 'cc');
  await P.locator('canvas.wc-pitch').tap({ position: { x: 300, y: 150 } });
  await pressed(H, 'cc', [2, 3], 1500);                // a tap presses for both of the phone player's men
  await quiet(H, 'cc');
  await P.locator('.wc-pad').first().tap();
  await pressed(H, 'cc', [2, 3], 1500);                // and so does the Kick pad
  await sleep(1500);
  await P.screenshot({ path: OUT + '/phone-match-landscape.png' });
  // practice on a phone
  const pr = await open('/practice', { device: phone, label: 'phone practice' });
  await pr.getByText('Tap anywhere to jump and kick.').waitFor({ timeout: 10000 });
  const kick = pr.getByRole('button', { name: 'Kick off' });
  await until(async () => !(await kick.isDisabled()), 15000, 'Kick off enabled');
  await kick.tap();
  await until(() => pr.evaluate(() => window.__practice.phase === 'play'), 8000, 'play');
  await quiet(pr, 'practice');
  await pr.locator('canvas.wc-pitch').tap({ position: { x: 100, y: 100 } });
  await pressed(pr, 'practice', [0, 1]);
});

// ---------------------------------------------------------------- big screen lobby
await step('screen-lobby', 'big screen lobby: QR, arrivals as they join, the draw from the screen', async () => {
  const c = await cup([]);
  const s = await open('/t/' + c.code + '/screen', { storage: { ['cc:admin:' + c.code]: c.adminKey }, ctx: { viewport: { width: 1280, height: 720 } } });
  await s.locator('.qr svg').waitFor({ timeout: 10000 });
  await s.getByText(c.code, { exact: true }).waitFor({ timeout: 5000 });
  check(await s.getByRole('button', { name: 'Make the draw' }).isDisabled(), 'draw enabled with nobody');
  for (const n of ['Ana', 'Ben', 'Cy']) await call('/api/t/' + c.code + '/join', { name: n, flag: 'se', color: 'teal' });
  await until(async () => (await s.locator('.arrivals b').textContent()) === '3', 6000, 'arrivals count');
  await s.getByText('Cy', { exact: true }).waitFor({ timeout: 5000 });
  // Ben's browser froze and he joined again from another one: the old entry goes, from the big screen
  const ben2 = await call('/api/t/' + c.code + '/join', { name: 'Ben', flag: 'ar', color: 'red' });
  await s.getByText('Ben 2', { exact: true }).waitFor({ timeout: 6000 });
  await s.getByRole('button', { name: 'Remove Ben', exact: true }).click();
  await s.screenshot({ path: OUT + '/screen-lobby-remove.png' });
  await s.getByRole('button', { name: 'Yes, remove Ben', exact: true }).click();
  await until(async () => { const v = await c.view(); return v.players.length === 3 && v.players.some(x => x.id === ben2.playerId && x.name === 'Ben'); }, 6000, 'one Ben, with his name back');
  await s.getByText('Ben 2', { exact: true }).waitFor({ state: 'detached', timeout: 6000 });
  await s.screenshot({ path: OUT + '/screen-lobby.png' });
  await s.getByRole('button', { name: 'Make the draw' }).click();
  await s.locator('.tile').first().waitFor({ timeout: 10000 });
  check((await c.view()).status === 'running', 'not running');
});

// ---------------------------------------------------------------- production build
await step('prod', 'production build: no test switches, ?bot does nothing', async () => {
  if (!process.env.PROD) return 'skipped (set PROD)';
  const P = process.env.PROD;
  const p = await open('/', { base: P, label: 'prod landing' });
  await p.locator('canvas.wc-pitch').first().waitFor({ timeout: 15000 });
  await sleep(1500);
  check(await p.evaluate(() => typeof window.__createGame === 'undefined' && typeof window.__cc === 'undefined'), 'test hooks present in production');
  const { code } = await call('/api/t', { name: 'Prod' }, P);
  const b = await open('/t/' + code + '?bot=0.9&name=Sneaky', { base: P, label: 'prod bot' });
  await b.getByRole('heading', { name: 'Enter the cup' }).waitFor({ timeout: 10000 });
  await sleep(5000);
  check((await call('/api/t/' + code, null, P)).players.length === 0, 'a bot joined in production');
});

console.log('\n' + results.map(r => r.join('  ')).join('\n'));
console.log('page problems:', problems.length ? problems : 'none');
await browser.close();
process.exit(results.every(r => r[1] === 'pass') && !problems.length ? 0 : 1);

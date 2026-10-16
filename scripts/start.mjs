// npm start: the built app and the match server together, for running the cup on your own
// computer (npm run build first). On the droplet each runs as its own service instead
// (deploy/), so a deploy of the app never stops a match.
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';

const env = { ...process.env, NODE_ENV: 'production' };
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
const PORT = env.PORT || '3000', MPORT = env.MATCH_PORT || '3001';
env.MATCH_SECRET ||= 'local-' + randomBytes(16).toString('hex');
env.MATCH_SERVER_URL ||= ':' + MPORT + '/ws';
env.APP_URL ||= 'http://127.0.0.1:' + PORT;
let stopping = false;
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', PORT], { env, stdio: 'inherit' });
let match = null, quick = 0;
// the match server comes back by itself if it stops (like systemd does on the droplet): a
// live match then carries on from its saved score
function startMatch() {
  const at = Date.now();
  match = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts'], { env: { ...env, MATCH_PORT: MPORT }, stdio: 'inherit' });
  match.on('exit', code => {
    if (stopping) return;
    quick = Date.now() - at < 5000 ? quick + 1 : 0;      // stopping again straight away: wait longer each time
    console.error('the match server stopped' + (code ? ' (code ' + code + ')' : '') + '; starting it again');
    setTimeout(startMatch, Math.min(10000, 1000 * (1 + quick)));
  });
}
startMatch();
const stop = () => { stopping = true; app.kill('SIGTERM'); match?.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
app.on('exit', code => { if (!stopping) { console.error('the app stopped' + (code ? ' with code ' + code : '')); stop(); process.exitCode = code || 1; } });

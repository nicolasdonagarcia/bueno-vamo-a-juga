// npm run dev: the app (next dev, http://localhost:3000) and the match server (port 3001)
// side by side, the match server restarting when its files change. Ctrl-C stops both.
// Players on the same Wi-Fi can join at http://<this computer's address>:3000.
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';

const env = { ...process.env };
// .env.local, if there is one (next dev reads it too; the match server needs the same secret)
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
const PORT = env.PORT || '3000', MPORT = env.MATCH_PORT || '3001';
env.MATCH_SECRET ||= 'dev-' + randomBytes(16).toString('hex');      // a new one each time is fine on your own computer
env.MATCH_SERVER_URL ||= ':' + MPORT + '/ws';                       // this page's host name, the match server's port
env.APP_URL ||= 'http://127.0.0.1:' + PORT;

const kids = [
  spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-p', PORT], { env, stdio: 'inherit' }),
  spawn(process.execPath, ['--watch-path=server', '--watch-path=lib', '--disable-warning=ExperimentalWarning', 'server/main.ts'],
    { env: { ...env, MATCH_PORT: MPORT }, stdio: 'inherit' })
];
const stop = () => { for (const k of kids) k.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const k of kids) k.on('exit', code => { if (code) { console.error('stopped with code ' + code); stop(); process.exitCode = code; } });

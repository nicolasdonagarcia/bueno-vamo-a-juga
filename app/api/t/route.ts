// Create a tournament. Returns the join code and the admin key (shown once).
import { getStore, storeProblem } from '@/lib/store';
import { DEFAULT_RULES, cleanName, type Tournament } from '@/lib/tournament';
import { body, fail, hash, json, newCode, secret } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const problem = storeProblem();
  if (problem) return fail(problem, 503);
  const b = await body(req);
  const name = cleanName(b.name) || 'The Coterie Cup';
  const adminKey = secret();
  for (let i = 0; i < 6; i++) {
    const code = newCode();
    const t: Tournament = {
      code, name, createdAt: Date.now(), adminKeyHash: hash(adminKey), status: 'lobby',
      rules: { ...DEFAULT_RULES }, players: [], matches: [], rounds: 0, champion: null
    };
    if (await getStore().create(t)) return json({ code, adminKey });
  }
  return fail('Could not create a tournament, try again.', 500);
}

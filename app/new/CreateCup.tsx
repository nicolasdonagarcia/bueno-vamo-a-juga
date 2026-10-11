'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Brand } from '@/components/bits';
import { Trophy } from '@/components/Trophy';
import { api, saved } from '@/lib/client';

export default function CreateCup() {
  const router = useRouter();
  const [name, setName] = useState('The Coterie Cup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ code: string; adminKey: string }>('/api/t', { name });
      saved.setAdmin(r.code, r.adminKey);
      router.push('/t/' + r.code + '/admin#k=' + encodeURIComponent(r.adminKey));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }
  return (
    <main className="page narrow">
      <header className="topbar"><Brand /></header>
      <form className="card stack" onSubmit={create}>
        <div className="row create-head">
          <Trophy className="trophy-sm" />
          <div className="stack tight-stack">
            <p className="kicker">For the organiser</p>
            <h1 className="h2">Start a cup</h1>
          </div>
        </div>
        <label className="field">
          <span>Name of the cup</span>
          <input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={18} required />
        </label>
        <p className="note">You will get a code for players, a big-screen page to share in your meeting, and an admin page to start the draw and fix results. Nobody needs an account.</p>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="row">
          <button className="btn" type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create the cup'}</button>
        </div>
      </form>
    </main>
  );
}

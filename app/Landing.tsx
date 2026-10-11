'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import GameView from '@/components/GameView';
import { Brand } from '@/components/bits';
import { normCode } from '@/lib/code';

export default function Landing() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const clean = normCode(code);
  return (
    <main className="page">
      <header className="topbar">
        <Brand />
        <nav className="row"><Link className="btn ghost small" href="/practice">Practice</Link></nav>
      </header>

      <section className="hero-grid">
        <div className="stack hero-copy">
          <p className="kicker">One button · 1v1 knockout</p>
          <h1 className="title">The Coterie Cup</h1>
          <p className="lead">Ragdoll football for the office. Everyone plays on their own laptop or phone, the winners go through, and one of you lifts the cup.</p>
          <form className="join-code" onSubmit={e => { e.preventDefault(); if (clean.length >= 4) router.push('/t/' + clean); }}>
            <label className="field">
              <span>Got a code?</span>
              <input className="input code" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="CODE"
                autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={8} aria-label="Cup code" />
            </label>
            <button className="btn" type="submit" disabled={clean.length < 4}>Join</button>
          </form>
          <div className="row">
            <Link className="btn ghost" href="/new">Start a cup</Link>
            <Link className="btn ghost" href="/practice">Practice against the CPU</Link>
          </div>
        </div>
        <div className="card hero hero-pitch">
          <div className="arena demo">
            <GameView opts={{ mode: 'demo', players: [{ name: 'Coterie', color: 'orange' }, { name: 'Rivals', color: 'teal' }], maxDpr: 1.5 }} />
          </div>
        </div>
      </section>

      <section className="how" aria-label="How it works">
        <article className="card">
          <p className="step">1</p>
          <h2 className="h3">Scan the code</h2>
          <p className="muted">The organiser puts the cup on the big screen. Scan the QR code, pick a name, a flag and your kit colour.</p>
        </article>
        <article className="card">
          <p className="step">2</p>
          <h2 className="h3">Play your match</h2>
          <p className="muted">When the draw is made, open your match and press ready. One button does everything: <kbd>Space</kbd>, <kbd>W</kbd> or <kbd>↑</kbd>, or tap.</p>
        </article>
        <article className="card">
          <p className="step">3</p>
          <h2 className="h3">Win, go through</h2>
          <p className="muted">First to 3 goals, with a time limit and then golden goal. Every goal shakes up the next round: moon gravity, ice, beach balls…</p>
        </article>
      </section>
    </main>
  );
}

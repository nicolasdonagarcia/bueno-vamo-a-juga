'use client';
import { Brand } from '@/components/bits';
import PracticeArena from '@/components/PracticeArena';

export default function Practice() {
  return (
    <main className="page wide play-page">
      <header className="topbar">
        <Brand />
        <p className="tiny muted hide-small">Practice · nothing here counts</p>
      </header>
      <PracticeArena full />
    </main>
  );
}

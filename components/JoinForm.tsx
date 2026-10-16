'use client';
import { useEffect, useState } from 'react';
import { COLORS } from '@/lib/engine/shared';
import { Snd } from '@/lib/engine/sound';
import { FLAG_LIST, guessFlag } from '@/lib/flags';
import { api, saved, type Profile, type SavedPlayer } from '@/lib/client';
import { Flag } from './bits';

export default function JoinForm({ code, current, token, onJoined, onCancel, takenColors }: {
  code: string;
  current?: Profile | null;                 // editing an existing entry
  token?: string | null;
  onJoined: (p: SavedPlayer) => void;
  onCancel?: () => void;
  takenColors?: Record<string, number>;
}) {
  const [name, setName] = useState(current?.name || '');
  const [flag, setFlag] = useState(current?.flag ?? '');
  const [color, setColor] = useState(current?.color || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (current) return;
    const p = saved.profile();
    if (p) { setName(p.name); setFlag(p.flag); setColor(p.color); return; }
    setFlag(guessFlag());
    setColor(COLORS[Math.floor(Math.random() * 8)].id);
  }, [current]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    Snd.unlock();
    setBusy(true); setError('');
    try {
      const r = await api<SavedPlayer>('/api/t/' + code + '/join', { name: name.trim(), flag, color: color || 'orange', token: token || undefined });
      saved.setProfile({ name: name.trim(), flag, color: color || 'orange' });
      onJoined(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack join-form" onSubmit={submit}>
      <h2 className="h2">{current ? 'Edit your entry' : 'Enter the cup'}</h2>
      <label className="field">
        <span>Your name</span>
        <input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={18} required autoComplete="nickname" placeholder="What people call you" />
      </label>
      <label className="field">
        <span>Flag</span>
        <div className="flag-select">
          <span className="flag-preview">{flag ? <Flag code={flag} /> : <span className="flag-none" aria-hidden="true" />}</span>
          <select className="select" value={flag} onChange={e => setFlag(e.target.value)}>
            <option value="">No flag</option>
            {FLAG_LIST.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </div>
      </label>
      <fieldset className="field">
        <legend>Kit colour</legend>
        <div className="swatches" role="radiogroup" aria-label="Kit colour">
          {COLORS.map(c => (
            <button key={c.id} type="button" className="swatch" role="radio" aria-checked={color === c.id} aria-label={c.name + (takenColors?.[c.id] ? ' (' + takenColors[c.id] + ' already)' : '')}
              title={c.name} style={{ background: c.hex }} onClick={() => setColor(c.id)} />
          ))}
        </div>
        <p className="note small hint-line">If you and your opponent pick the same colour, the right-hand player wears white or black.</p>
      </fieldset>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="row">
        <button className="btn" type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : current ? 'Save' : 'Join the cup'}</button>
        {onCancel ? <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button> : null}
      </div>
    </form>
  );
}

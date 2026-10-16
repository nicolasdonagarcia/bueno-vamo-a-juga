'use client';
// Small shared pieces: flags, player chips, the brand, copy and QR.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { colorById } from '@/lib/engine/shared';
import { flagName } from '@/lib/flags';
import type { PublicPlayer } from '@/lib/tournament';
import { CupMark } from './Trophy';

export function Flag({ code, label }: { code?: string | null; label?: boolean }) {
  if (!code) return null;
  const name = label ? flagName(code) : '';
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="flag" src={'/flags/' + code + '.svg'} alt={name} title={flagName(code) || undefined} width={20} height={15} />;
}

export function Dot({ color }: { color: string }) {
  const hex = colorById(color).hex;
  return <span className="dot" style={{ background: hex, color: hex }} aria-hidden="true" />;
}

export function PlayerChip({ p, me, fallback }: { p?: PublicPlayer | null; me?: boolean; fallback?: string }) {
  if (!p) return <span className="chip tbd"><span className="nm">{fallback || 'To be decided'}</span></span>;
  return (
    <span className="chip">
      <Dot color={p.color} />
      <Flag code={p.flag} />
      <span className="nm">{p.name}</span>
      {me ? <span className="you">you</span> : null}
    </span>
  );
}

export function Brand({ href = '/', name }: { href?: string; name?: string }) {
  return (
    <Link className="brand" href={href}>
      <CupMark />
      <span>{name || 'The Coterie Cup'}</span>
    </Link>
  );
}

export function CopyButton({ text, label = 'Copy', className = 'btn ghost small' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 1600); return () => clearTimeout(t); }, [done]);
  return (
    <button type="button" className={className} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); }
      catch { window.prompt('Copy this:', text); }
    }}>{done ? 'Copied' : label}</button>
  );
}

export function QR({ text, label }: { text: string; label?: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    import('qrcode').then(Q => Q.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#060818', light: '#ffffff' } }))
      .then(s => { if (live) setSvg(s); })
      .catch(() => { });
    return () => { live = false; };
  }, [text]);
  return <div className="qr" role="img" aria-label={label || 'QR code for ' + text} dangerouslySetInnerHTML={{ __html: svg }} />;
}

// The organiser taking a player out of the lobby (typically a second entry left behind by a
// frozen browser): × first, then Remove / Keep, so a slip of the mouse doesn't do it.
export function RemovePlayer({ name, onRemove }: { name: string; onRemove: () => Promise<unknown> }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!ask) {
    return <button type="button" className="icon-btn rm" aria-label={'Remove ' + name} title={'Remove ' + name} onClick={() => setAsk(true)}>×</button>;
  }
  return (
    <span className="rm-ask">
      <button type="button" className="btn danger tiny" disabled={busy} aria-label={'Yes, remove ' + name}
        onClick={async () => { setBusy(true); try { await onRemove(); } finally { setBusy(false); setAsk(false); } }}>Remove</button>
      <button type="button" className="btn ghost tiny" disabled={busy} onClick={() => setAsk(false)}>Keep</button>
    </span>
  );
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return <div className="loading" role="status"><span className="spinner" aria-hidden="true" />{text}</div>;
}

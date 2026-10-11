'use client';
import { useId } from 'react';

// The Coterie Cup itself: a two-handled cup with a star, on a plinth.
export function Trophy({ className, title }: { className?: string; title?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const g = 'tg' + id, s = 'ts' + id;
  return (
    <svg className={className} viewBox="0 0 120 150" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#a8760c" />
          <stop offset=".38" stopColor="#ffe27a" />
          <stop offset=".55" stopColor="#fff3b8" />
          <stop offset="1" stopColor="#b98510" />
        </linearGradient>
        <linearGradient id={s} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe27a" />
          <stop offset="1" stopColor="#c48d12" />
        </linearGradient>
      </defs>
      <path d="M29 28 C8 27 7 62 36 69" fill="none" stroke={`url(#${s})`} strokeWidth="7" strokeLinecap="round" />
      <path d="M91 28 C112 27 113 62 84 69" fill="none" stroke={`url(#${s})`} strokeWidth="7" strokeLinecap="round" />
      <path d="M23 17 H97 V38 C97 64 81 82 60 84 C39 82 23 64 23 38 Z" fill={`url(#${g})`} />
      <rect x="19" y="11" width="82" height="10" rx="5" fill="#fff0a8" />
      <path d="M23 46 H97" stroke="#8a5f08" strokeOpacity=".35" strokeWidth="3" />
      <path d="M60 30 l4.3 8.8 9.7 1.4 -7 6.8 1.7 9.6 -8.7 -4.6 -8.7 4.6 1.7 -9.6 -7 -6.8 9.7 -1.4 Z" fill="#fffbe0" opacity=".95" />
      <path d="M53 83 H67 L64.5 101 H55.5 Z" fill={`url(#${g})`} />
      <ellipse cx="60" cy="103" rx="17" ry="5" fill={`url(#${g})`} />
      <rect x="35" y="106" width="50" height="9" rx="3" fill={`url(#${g})`} />
      <rect x="28" y="115" width="64" height="24" rx="4" fill="#1b2147" stroke={`url(#${s})`} strokeWidth="3" />
      <rect x="40" y="122" width="40" height="9" rx="2" fill={`url(#${g})`} opacity=".9" />
    </svg>
  );
}

// small mark for the top bar
export function CupMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M8.5 7.5c-5 0-5 8 1.5 9.5M23.5 7.5c5 0 5 8-1.5 9.5" fill="none" stroke="#ffd43b" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M7 4h18v6.5c0 6-3.8 10-9 10.3C10.8 20.5 7 16.5 7 10.5Z" fill="#ffd43b" />
      <path d="M14 20.5h4l-.6 4.5h-2.8Z M10 25h12v3.5H10Z" fill="#ffd43b" />
    </svg>
  );
}

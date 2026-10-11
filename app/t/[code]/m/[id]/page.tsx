import type { Metadata } from 'next';
import { normCode } from '@/lib/code';
import MatchClient from './MatchClient';

export const metadata: Metadata = { title: 'Match' };

export default async function Page({ params, searchParams }: {
  params: Promise<{ code: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { code, id } = await params;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';
  return <MatchClient code={normCode(code)} id={String(id).slice(0, 12)} local={one(sp.local) === '1'} bot={one(sp.bot)} from={one(sp.from)} />;
}

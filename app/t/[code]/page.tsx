import type { Metadata } from 'next';
import { normCode } from '@/lib/code';
import Hub from './Hub';

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  return { title: 'Cup ' + normCode(code) };
}

export default async function Page({ params, searchParams }: {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { code } = await params;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';
  return <Hub code={normCode(code)} bot={one(sp.bot)} botName={one(sp.name)} />;
}

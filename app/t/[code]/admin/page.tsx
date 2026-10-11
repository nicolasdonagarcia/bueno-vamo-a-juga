import type { Metadata } from 'next';
import { normCode } from '@/lib/code';
import Admin from './Admin';

export const metadata: Metadata = { title: 'Admin', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <Admin code={normCode(code)} />;
}

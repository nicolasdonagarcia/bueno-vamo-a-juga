import type { Metadata } from 'next';
import { normCode } from '@/lib/code';
import Screen from './Screen';

export const metadata: Metadata = { title: 'Big screen' };

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <Screen code={normCode(code)} />;
}

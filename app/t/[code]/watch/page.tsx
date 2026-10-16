import type { Metadata } from 'next';
import { normCode } from '@/lib/code';
import Screen from '../screen/Screen';

export const metadata: Metadata = { title: 'Watch live' };

// The live match for everybody who has the cup's link: players and anyone else. The same view as
// the organiser's big screen, without its controls.
export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <Screen code={normCode(code)} watch />;
}

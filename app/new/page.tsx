import type { Metadata } from 'next';
import CreateCup from './CreateCup';

export const metadata: Metadata = { title: 'Start a cup' };

export default function Page() {
  return <CreateCup />;
}

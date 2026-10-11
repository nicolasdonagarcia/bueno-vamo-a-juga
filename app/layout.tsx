import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import './game.css';

// Lilita One and Nunito (SIL Open Font License), bundled so nothing loads from elsewhere
const display = localFont({ src: './fonts/lilita-one-400.woff2', weight: '400', variable: '--font-display', display: 'swap' });
const body = localFont({
  src: [
    { path: './fonts/nunito-700.woff2', weight: '700' },
    { path: './fonts/nunito-800.woff2', weight: '800' },
    { path: './fonts/nunito-900.woff2', weight: '900' }
  ],
  variable: '--font-body',
  display: 'swap'
});

export const metadata: Metadata = {
  title: { default: 'The Coterie Cup', template: '%s · The Coterie Cup' },
  description: 'One-button ragdoll football. A 1v1 knockout cup for the office, played on your own laptop or phone.',
  applicationName: 'The Coterie Cup'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#060818',
  colorScheme: 'dark'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={display.variable + ' ' + body.variable}>
      <body>{children}</body>
    </html>
  );
}

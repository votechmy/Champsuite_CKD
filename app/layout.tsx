import type { Metadata } from 'next';
import { Fraunces, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import Link from 'next/link';
import { ImageEnlargeProvider } from '@/components/ImageEnlargeProvider';
import './globals.css';

// Display: Fraunces variable serif. Used for H1/H2/H3 + dashboard hero numbers.
// Risk-by-design — most pricing tools go full sans. The serif on big numbers
// gives the dashboard editorial weight without enterprise-SaaS vibe.
const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  display: 'swap',
  weight: ['400', '500', '600'],
  axes: ['SOFT', 'opsz'],
});

// Body / UI / table cells. Tabular-nums on by default for prices.
const interTight = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-inter-tight',
  display: 'swap',
  weight: ['400', '500', '600'],
});

// IDs, code, technical strings.
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
  weight: ['400', '500'],
});

export const metadata: Metadata = {
  title: 'ChampSuite CKD',
  description: 'Card Kingdom pricelist mirror — Cards & Hobbies pricing terminal',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${interTight.variable} ${jetbrainsMono.variable}`}>
      <body>
        <header className="header">
          <Link href="/" className="brand">ChampSuite CKD</Link>
          <nav>
            <Link href="/list">Pricelist</Link>
            <Link href="/compare">Compare</Link>
            <Link href="/sync-log">Sync log</Link>
          </nav>
        </header>
        <main>{children}</main>
        <ImageEnlargeProvider />
      </body>
    </html>
  );
}

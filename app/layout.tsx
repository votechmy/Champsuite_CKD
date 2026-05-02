import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ChampSuite CKD',
  description: 'Card Kingdom pricelist mirror — Cards & Hobbies',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="header">
          <a href="/" className="brand">ChampSuite CKD</a>
          <nav>
            <a href="/list">Pricelist</a>
            <a href="/compare">Compare</a>
            <a href="/sync-log">Sync log</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}

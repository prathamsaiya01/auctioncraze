import type { Metadata } from 'next';
import { Barlow_Condensed, Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

const barlowCondensed = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-display'
});

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans'
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--font-mono'
});

export const metadata: Metadata = {
  title: 'AuctionCraze | Live Multiplayer IPL Cricket Auction',
  description:
    'Create a room, claim an IPL franchise, invite friends, and battle in a live server-authoritative multiplayer cricket auction.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${barlowCondensed.variable} ${plusJakarta.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-screen stadium-backdrop font-sans text-stadium-text antialiased selection:bg-gold-500/30 selection:text-gold-300">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

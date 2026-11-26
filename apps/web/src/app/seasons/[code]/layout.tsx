import type { Metadata } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4001/api/v1';

export async function generateMetadata({
  params
}: {
  params: { code: string };
}): Promise<Metadata> {
  const seasonCode = decodeURIComponent(params.code || '').toUpperCase();
  const fallbackTitle = `Season ${seasonCode} Leaderboard | AuctionCraze`;
  const fallbackDesc =
    'Join this AuctionCraze season to claim your persistent franchise identity without login and track live standings.';

  try {
    const res = await fetch(`${API_URL}/seasons/${encodeURIComponent(seasonCode)}`, {
      cache: 'no-store'
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      const season = body?.data;
      if (season?.name) {
        const title = `${season.name} (${season.code}) | AuctionCraze Season`;
        const desc =
          season.description ||
          `View live franchise standings across ${season.auctionCount || 0} auctions in ${season.name}.`;
        return {
          title,
          description: desc,
          openGraph: { title, description: desc, type: 'website' },
          twitter: { card: 'summary', title, description: desc }
        };
      }
    }
  } catch {
    // Graceful fallback
  }

  return {
    title: fallbackTitle,
    description: fallbackDesc,
    openGraph: { title: fallbackTitle, description: fallbackDesc, type: 'website' },
    twitter: { card: 'summary', title: fallbackTitle, description: fallbackDesc }
  };
}

export default function SeasonLayout({ children }: { children: React.ReactNode }) {
  return children;
}

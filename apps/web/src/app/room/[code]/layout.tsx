import type { Metadata } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4001/api/v1';

export async function generateMetadata({
  params
}: {
  params: { code: string };
}): Promise<Metadata> {
  const roomCode = decodeURIComponent(params.code || '').toUpperCase();
  const fallbackTitle = `Join Auction Room ${roomCode} | AuctionCraze`;
  const fallbackDesc =
    'Open this AuctionCraze invite link to claim an IPL franchise or watch as a spectator in real time (no login required).';

  try {
    const res = await fetch(`${API_URL}/rooms/${encodeURIComponent(roomCode)}`, {
      cache: 'no-store'
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      const room = body?.data;
      if (room?.name && room?.visibility === 'PUBLIC') {
        const seasonSuffix = room.seasonName ? ` • ${room.seasonName}` : '';
        const title = `${room.name} (${room.code})${seasonSuffix} | AuctionCraze`;
        const desc = `Join ${room.name} on AuctionCraze — claim an available franchise or spectate live (${room.status}).`;
        return {
          title,
          description: desc,
          openGraph: { title, description: desc, type: 'website' },
          twitter: { card: 'summary', title, description: desc }
        };
      }
    }
  } catch {
    // Private room (403) or unreachable API falls back cleanly without leaking private room metadata
  }

  return {
    title: fallbackTitle,
    description: fallbackDesc,
    openGraph: { title: fallbackTitle, description: fallbackDesc, type: 'website' },
    twitter: { card: 'summary', title: fallbackTitle, description: fallbackDesc }
  };
}

export default function RoomLayout({ children }: { children: React.ReactNode }) {
  return children;
}

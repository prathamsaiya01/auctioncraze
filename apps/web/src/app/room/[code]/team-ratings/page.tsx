'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { formatLakhs } from '@/lib/formatPrice';
import { useSessionStore } from '@/stores/sessionStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FranchiseEmblem } from '@/components/ui/FranchiseEmblem';
import { FranchiseReportView } from '@/components/room/FranchiseReportView';
import { PlayerProfileModal } from '@/components/players/PlayerProfileModal';
import {
  ArrowLeft,
  ArrowUpDown,
  BarChart3,
  Clock,
  Lock,
  RefreshCw,
  ShieldCheck,
  Trophy
} from 'lucide-react';

type SortField =
  | 'rank'
  | 'overallRating'
  | 'battingStrength'
  | 'bowlingStrength'
  | 'allRounderStrength'
  | 'squadDepth'
  | 'paceCoverage'
  | 'spinCoverage'
  | 'wicketkeeperCoverage'
  | 'roleBalance';

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return Number(v).toFixed(1);
}

export default function PostAuctionTeamRatingsPage() {
  const params = useParams<{ code: string }>();
  const roomCode = String(params?.code || '').trim().toUpperCase();
  const { token, isHydrated, hydrate } = useSessionStore();

  const [readiness, setReadiness] = useState<any | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [hostRatings, setHostRatings] = useState<any | null>(null);
  const [selectedFranchiseId, setSelectedFranchiseId] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<any | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [recalculating, setRecalculating] = useState(false);

  const [sortField, setSortField] = useState<SortField>('rank');
  const [sortAsc, setSortAsc] = useState(true);
  const [chartMetric, setChartMetric] = useState<
    'overallRating' | 'battingStrength' | 'bowlingStrength' | 'allRounderStrength' | 'squadDepth' | 'roleBalance'
  >('overallRating');

  const [inspectedPlayerId, setInspectedPlayerId] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const loadFranchiseReport = useCallback(
    async (fid: string) => {
      if (!roomCode || !fid) return;
      setReportLoading(true);
      try {
        const res: any = await api.get(
          `/intelligence/rooms/${encodeURIComponent(roomCode)}/post-auction/franchises/${encodeURIComponent(fid)}/report`
        );
        setSelectedReport(res.data);
      } catch {
        setSelectedReport(null);
      } finally {
        setReportLoading(false);
      }
    },
    [roomCode]
  );

  const loadDashboard = useCallback(async () => {
    if (!isHydrated) return;
    if (!roomCode) {
      setAuthError('Room code is required.');
      setLoading(false);
      return;
    }
    if (!token) {
      setAuthError('Sign in with your room participant session to view post-auction ratings.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setAuthError(null);
    try {
      const rRes: any = await api.get(
        `/intelligence/rooms/${encodeURIComponent(roomCode)}/post-auction/readiness`
      );
      const rData = rRes.data;
      setReadiness(rData);

      if (!rData.isCompleted) {
        setLoading(false);
        return;
      }

      if (rData.isHost) {
        const ratingsRes: any = await api.get(
          `/intelligence/rooms/${encodeURIComponent(roomCode)}/post-auction/ratings`
        );
        const hData = ratingsRes.data;
        setHostRatings(hData);
        const firstId = hData?.overallRankings?.[0]?.franchiseId || rData.ownedFranchiseId;
        setSelectedFranchiseId(firstId);
        if (firstId) {
          await loadFranchiseReport(firstId);
        }
      } else {
        setSelectedFranchiseId(rData.ownedFranchiseId);
        await loadFranchiseReport(rData.ownedFranchiseId);
      }
    } catch (err: any) {
      setAuthError(err?.message || 'Access denied.');
    } finally {
      setLoading(false);
    }
  }, [isHydrated, token, roomCode, loadFranchiseReport]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const handleRecalculate = async () => {
    if (!readiness?.isHost || recalculating) return;
    setRecalculating(true);
    try {
      const res: any = await api.post(
        `/intelligence/rooms/${encodeURIComponent(roomCode)}/post-auction/recalculate`,
        {}
      );
      setHostRatings(res.data);
      if (selectedFranchiseId) {
        await loadFranchiseReport(selectedFranchiseId);
      }
    } finally {
      setRecalculating(false);
    }
  };

  const sortedTeams = useMemo(() => {
    const list: any[] = [...(hostRatings?.overallRankings || [])];
    list.sort((a, b) => {
      if (sortField === 'rank') {
        const ra = a.rank ?? 9999;
        const rb = b.rank ?? 9999;
        return sortAsc ? ra - rb : rb - ra;
      }
      const va = typeof a[sortField] === 'number' ? a[sortField] : -1;
      const vb = typeof b[sortField] === 'number' ? b[sortField] : -1;
      return sortAsc ? va - vb : vb - va;
    });
    return list;
  }, [hostRatings, sortField, sortAsc]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortField(field);
      setSortAsc(field === 'rank');
    }
  };

  if (!isHydrated || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stadium-canvas p-6">
        <div className="text-center space-y-3">
          <div className="w-9 h-9 border-2 border-gold-400 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-stadium-muted">Analyzing finalized auction squads...</p>
        </div>
      </div>
    );
  }

  if (authError || !readiness) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-stadium-canvas p-6"
        data-testid="post-auction-access-denied"
      >
        <Card className="max-w-lg w-full p-7 text-center space-y-4 border-amber-500/40">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/35 text-amber-400 flex items-center justify-center mx-auto">
            <Lock className="w-6 h-6" />
          </div>
          <Badge tone="unsold">RESTRICTED ACCESS</Badge>
          <h1 className="font-display text-2xl font-extrabold text-white tracking-wide">
            POST-AUCTION TEAM RATINGS UNAVAILABLE
          </h1>
          <p className="text-xs text-stadium-muted leading-relaxed">
            {authError || 'Post-auction franchise analytics are restricted to authorized room franchise owners and the host.'}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <Link href={roomCode ? `/room/${roomCode}` : '/'}>
              <Button variant="surface" size="sm">
                <ArrowLeft className="w-3.5 h-3.5" /> Back to Room
              </Button>
            </Link>
            <Link href="/players">
              <Button variant="electric" size="sm">
                Public Player Archive
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  if (!readiness.isCompleted) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-stadium-canvas p-6"
        data-testid="auction-not-completed-banner"
      >
        <Card highlight="gold" className="max-w-lg w-full p-7 text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-gold-500/15 border border-gold-500/35 text-gold-400 flex items-center justify-center mx-auto">
            <Clock className="w-6 h-6" />
          </div>
          <Badge tone="gold">{readiness.roomStatus}</Badge>
          <h1 className="font-display text-2xl font-extrabold text-white tracking-wide">
            AUCTION NOT YET COMPLETED
          </h1>
          <p className="text-xs text-stadium-muted leading-relaxed">{readiness.message}</p>
          <Link href={`/room/${readiness.roomCode}/auction`}>
            <Button variant="gold" size="sm">
              <ArrowLeft className="w-3.5 h-3.5" /> Return to Live Auction Room
            </Button>
          </Link>
        </Card>
      </div>
    );
  }

  const snapshotVersion = hostRatings?.snapshotVersion ?? selectedReport?.snapshotVersion ?? 1;
  const calculatedAt = hostRatings?.calculatedAt ?? selectedReport?.calculatedAt;

  return (
    <div className="min-h-screen flex flex-col bg-stadium-canvas">
      {/* Broadcast Top Bar */}
      <header className="border-b border-stadium-border/80 bg-stadium-bg/90 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link href={`/room/${readiness.roomCode}/auction`}>
              <Button variant="surface" size="sm">
                <ArrowLeft className="w-3.5 h-3.5" /> Auction Room
              </Button>
            </Link>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="font-display text-xl sm:text-2xl font-extrabold tracking-wide text-white truncate">
                  POST-AUCTION <span className="text-gold-400">TEAM RATINGS</span>
                </h1>
                <Badge tone="gold">{readiness.isHost ? 'HOST OVERVIEW' : `${readiness.ownedFranchiseCode} REPORT`}</Badge>
              </div>
              <p className="text-[11px] font-mono text-stadium-muted truncate">
                {readiness.roomCode} • Snapshot v{snapshotVersion}
                {calculatedAt ? ` • Calculated ${new Date(calculatedAt).toLocaleTimeString()}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {readiness.isHost && (
              <Button
                variant="electric"
                size="sm"
                onClick={handleRecalculate}
                isLoading={recalculating}
                leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
                data-testid="recalculate-ratings-btn"
              >
                Recalculate
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Non-Bidding & Non-Official Analytics Guardrail Strip */}
        <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-2 text-emerald-200 font-medium">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            Computed exclusively from finalized SOLD &amp; RETAINED auction squads (unsold lots excluded).
            Non-official statistical ratings • Zero buying/retention advice.
          </span>
          {hostRatings?.poolSummary && (
            <span className="font-mono text-[11px] text-emerald-300">
              Sold: {hostRatings.poolSummary.soldCount} • Unsold Excluded: {hostRatings.poolSummary.unsoldExcludedCount}
            </span>
          )}
        </div>

        {/* HOST-ONLY SECTIONS: 1. League Rankings, 2. Comparative Charts, 3. Sortable Table */}
        {readiness.isHost && hostRatings && (
          <>
            {/* Section 1: League-Wide Team Rankings & Rating Cards */}
            <section className="space-y-3" data-testid="host-league-rankings">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-2xl font-bold text-white tracking-wide flex items-center gap-2">
                  <Trophy className="w-5 h-5 text-gold-400" />
                  LEAGUE-WIDE TEAM RANKINGS
                </h2>
                <span className="text-xs text-stadium-muted">
                  Insufficient-data teams (&lt;5 players) remain unranked
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
                {(hostRatings.overallRankings || []).map((t: any) => {
                  const isSelected = selectedFranchiseId === t.franchiseId;
                  return (
                    <button
                      key={t.franchiseId}
                      type="button"
                      onClick={() => {
                        setSelectedFranchiseId(t.franchiseId);
                        loadFranchiseReport(t.franchiseId);
                      }}
                      data-testid={`ranking-card-${t.franchiseCode}`}
                      className={`text-left rounded-2xl border p-4 transition-all space-y-3 ${
                        isSelected
                          ? 'bg-stadium-elevated border-gold-400 shadow-gold-glow'
                          : 'bg-stadium-card/70 border-stadium-border hover:border-gold-500/45'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <FranchiseEmblem
                            code={t.franchiseCode}
                            primaryColor={t.primaryColor}
                            secondaryColor={t.secondaryColor}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <p className="font-display font-bold text-lg text-white truncate">
                              {t.franchiseCode}
                            </p>
                            <p className="text-[11px] text-stadium-muted truncate">
                              {t.ownerDisplayName || 'Unclaimed'}
                            </p>
                          </div>
                        </div>
                        {t.rank ? (
                          <Badge tone={t.rank === 1 ? 'gold' : 'electric'}>#{t.rank}</Badge>
                        ) : (
                          <Badge tone="unsold">Insufficient Data</Badge>
                        )}
                      </div>

                      <div className="flex items-baseline justify-between border-t border-stadium-border/60 pt-2.5">
                        <div>
                          <p className="text-[10px] uppercase text-stadium-muted">Overall</p>
                          <p className="font-mono text-2xl font-extrabold text-gold-300">
                            {t.overallRating !== null && t.overallRating !== undefined
                              ? fmt(t.overallRating)
                              : 'N/A'}
                          </p>
                        </div>
                        <div className="text-right font-mono text-[11px] text-stadium-muted">
                          <p className="text-white">{t.squadSize} Players</p>
                          <p>Bat {fmt(t.battingStrength)} • Bowl {fmt(t.bowlingStrength)}</p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Section 2: Comparative Analytics Visual Chart */}
            <Card className="p-5 space-y-4" data-testid="comparative-analytics-chart">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stadium-border pb-3">
                <h2 className="font-display text-xl font-bold text-white tracking-wide flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-electric-400" />
                  COMPARATIVE FRANCHISE ANALYTICS
                </h2>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { k: 'overallRating', label: 'Overall' },
                    { k: 'battingStrength', label: 'Batting' },
                    { k: 'bowlingStrength', label: 'Bowling' },
                    { k: 'allRounderStrength', label: 'All-Rounder' },
                    { k: 'squadDepth', label: 'Depth' },
                    { k: 'roleBalance', label: 'Role Balance' }
                  ].map((m) => (
                    <button
                      key={m.k}
                      type="button"
                      onClick={() => setChartMetric(m.k as any)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
                        chartMetric === m.k
                          ? 'bg-electric-500 text-white'
                          : 'bg-stadium-card text-stadium-muted border border-stadium-border hover:text-white'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2.5">
                {sortedTeams.map((t: any) => {
                  const val = typeof t[chartMetric] === 'number' ? t[chartMetric] : 0;
                  const missing = t[chartMetric] === null || t[chartMetric] === undefined;
                  return (
                    <div key={t.franchiseId} className="grid grid-cols-12 items-center gap-3 text-xs">
                      <div className="col-span-3 sm:col-span-2 flex items-center gap-2 font-mono font-bold text-white">
                        <span className="w-6 text-gold-300">{t.rank ? `#${t.rank}` : '—'}</span>
                        <span>{t.franchiseCode}</span>
                      </div>
                      <div className="col-span-7 sm:col-span-8 h-5 rounded-full bg-stadium-bg border border-stadium-border overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            missing
                              ? 'bg-stadium-muted/20'
                              : chartMetric === 'overallRating'
                              ? 'bg-gradient-to-r from-gold-600 to-gold-400'
                              : 'bg-gradient-to-r from-electric-600 to-electric-400'
                          }`}
                          style={{ width: `${Math.min(100, Math.max(0, val))}%` }}
                        />
                      </div>
                      <div className="col-span-2 text-right font-mono font-bold text-white">
                        {missing ? 'N/A' : fmt(val)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* Section 3: Sortable League-Wide Comparison Table */}
            <Card className="p-5 space-y-3" data-testid="team-comparison-table">
              <div className="flex items-center justify-between border-b border-stadium-border pb-3">
                <h2 className="font-display text-xl font-bold text-white tracking-wide">
                  FRANCHISE COMPARISON MATRIX
                </h2>
                <span className="text-[11px] text-stadium-muted">
                  Click any column to sort • Click any row to inspect detailed franchise report
                </span>
              </div>

              <div className="overflow-x-auto rounded-xl border border-stadium-border">
                <table className="w-full text-left text-xs whitespace-nowrap">
                  <thead className="bg-stadium-bg/85 text-[10px] uppercase tracking-wider text-stadium-muted border-b border-stadium-border">
                    <tr>
                      {(
                        [
                          { k: 'rank', label: 'Rank' },
                          { k: null, label: 'Franchise' },
                          { k: null, label: 'Squad' },
                          { k: 'overallRating', label: 'Overall' },
                          { k: 'battingStrength', label: 'Batting' },
                          { k: 'bowlingStrength', label: 'Bowling' },
                          { k: 'allRounderStrength', label: 'AR' },
                          { k: 'squadDepth', label: 'Depth' },
                          { k: 'paceCoverage', label: 'Pace' },
                          { k: 'spinCoverage', label: 'Spin' },
                          { k: 'wicketkeeperCoverage', label: 'WK' },
                          { k: 'roleBalance', label: 'Balance' },
                          { k: null, label: 'OS' },
                          { k: null, label: 'Status' }
                        ] as Array<{ k: SortField | null; label: string }>
                      ).map((col) => (
                        <th key={col.label} className="px-3 py-2.5">
                          {col.k ? (
                            <button
                              type="button"
                              onClick={() => toggleSort(col.k!)}
                              className="inline-flex items-center gap-1 hover:text-white"
                            >
                              {col.label}
                              <ArrowUpDown className="w-3 h-3" />
                            </button>
                          ) : (
                            col.label
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stadium-border/60 font-mono">
                    {sortedTeams.map((t: any) => (
                      <tr
                        key={t.franchiseId}
                        onClick={() => {
                          setSelectedFranchiseId(t.franchiseId);
                          loadFranchiseReport(t.franchiseId);
                        }}
                        className={`cursor-pointer transition-colors ${
                          selectedFranchiseId === t.franchiseId
                            ? 'bg-gold-500/10'
                            : 'hover:bg-white/[0.04]'
                        }`}
                      >
                        <td className="px-3 py-2.5 font-bold text-gold-300">{t.rank ? `#${t.rank}` : '—'}</td>
                        <td className="px-3 py-2.5 font-sans font-semibold text-white">
                          {t.franchiseCode} · {t.franchiseName}
                        </td>
                        <td className="px-3 py-2.5 text-white">{t.squadSize}</td>
                        <td className="px-3 py-2.5 font-bold text-gold-300">{fmt(t.overallRating)}</td>
                        <td className="px-3 py-2.5 text-signal-sold">{fmt(t.battingStrength)}</td>
                        <td className="px-3 py-2.5 text-electric-400">{fmt(t.bowlingStrength)}</td>
                        <td className="px-3 py-2.5 text-white">{fmt(t.allRounderStrength)}</td>
                        <td className="px-3 py-2.5 text-white">{fmt(t.squadDepth)}</td>
                        <td className="px-3 py-2.5 text-stadium-muted">{fmt(t.paceCoverage)}</td>
                        <td className="px-3 py-2.5 text-stadium-muted">{fmt(t.spinCoverage)}</td>
                        <td className="px-3 py-2.5 text-stadium-muted">{fmt(t.wicketkeeperCoverage)}</td>
                        <td className="px-3 py-2.5 text-white">{fmt(t.roleBalance)}</td>
                        <td className="px-3 py-2.5 text-stadium-muted">
                          {t.overseasComposition?.overseas_count ?? 0}/{t.overseasComposition?.max_overseas ?? 8}
                        </td>
                        <td className="px-3 py-2.5 font-sans">
                          <Badge
                            tone={
                              t.sufficiencyStatus === 'SUFFICIENT'
                                ? 'sold'
                                : t.sufficiencyStatus === 'INCOMPLETE_SQUAD'
                                ? 'gold'
                                : 'unsold'
                            }
                          >
                            {t.sufficiencyStatus}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

        {/* Section 4 & 5: Detailed Franchise Report + Playing XI & Impact Player */}
        <section className="space-y-4">
          {readiness.isHost && hostRatings?.overallRankings?.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-stadium-muted mr-1">
                Inspect Detailed Franchise Report:
              </span>
              {hostRatings.overallRankings.map((t: any) => (
                <button
                  key={t.franchiseId}
                  type="button"
                  data-testid={`select-report-${t.franchiseCode}`}
                  onClick={() => {
                    setSelectedFranchiseId(t.franchiseId);
                    loadFranchiseReport(t.franchiseId);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    selectedFranchiseId === t.franchiseId
                      ? 'bg-gold-500 text-stadium-bg'
                      : 'bg-stadium-card text-stadium-muted border border-stadium-border hover:text-white'
                  }`}
                >
                  {t.franchiseCode} {t.rank ? `(#${t.rank})` : '(N/A)'}
                </button>
              ))}
            </div>
          )}

          {reportLoading ? (
            <Card className="p-8 text-center text-xs text-stadium-muted">
              Loading franchise detailed report...
            </Card>
          ) : selectedReport?.report ? (
            <FranchiseReportView
              report={selectedReport.report}
              onInspectPlayer={(pid) => setInspectedPlayerId(pid)}
            />
          ) : null}
        </section>
      </main>

      <PlayerProfileModal
        playerId={inspectedPlayerId}
        onClose={() => setInspectedPlayerId(null)}
        intelligenceRoomCode={readiness.roomCode}
        canViewIntelligence={true}
      />
    </div>
  );
}

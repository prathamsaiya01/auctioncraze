'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  AuctionMode,
  IPL_FRANCHISE_PRESETS,
  RoomVisibility,
  SOCKET_EVENTS,
  SeasonDetailDto,
  SeasonStatus
} from '@auctioncraze/shared';
import { api } from '@/lib/api';
import { getRoomSocket } from '@/lib/socket';
import { useSessionStore } from '@/stores/sessionStore';
import { buildSeasonInviteUrl, copyTextSafely, shareInviteLink } from '@/lib/shareLinks';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FranchiseEmblem } from '@/components/ui/FranchiseEmblem';
import { Input } from '@/components/ui/Input';
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Calendar,
  CheckCircle2,
  Copy,
  Crown,
  History,
  KeyRound,
  Minus,
  Plus,
  RefreshCw,
  Shield,
  Trophy,
  UserCheck
} from 'lucide-react';

export default function SeasonLeaderboardPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const seasonCode = decodeURIComponent(params.code || '').toUpperCase();

  const { session, token, isHydrated, hydrate, ensureSession } = useSessionStore();

  const [season, setSeason] = useState<SeasonDetailDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Filters
  const [monthFilter, setMonthFilter] = useState<string>('');
  const [roomFilter, setRoomFilter] = useState<string>('');

  // Login-free franchise selection state
  const [claimName, setClaimName] = useState('');
  const [claimCode, setClaimCode] = useState<string>('CSK');
  const [claimSuffix, setClaimSuffix] = useState('');
  const [recoveryTokenInput, setRecoveryTokenInput] = useState('');
  const [isClaiming, setIsClaiming] = useState(false);

  // Host create monthly auction state
  const [roomName, setRoomName] = useState('');
  const [monthLabel, setMonthLabel] = useState('November Auction');
  const [monthKey, setMonthKey] = useState('2026-11');
  const [hostFranchiseCode, setHostFranchiseCode] = useState('CSK');
  const [roomMode, setRoomMode] = useState<AuctionMode>(AuctionMode.MOCK);
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);

  // Host manual point adjustment state
  const [pointEntryId, setPointEntryId] = useState('');
  const [pointDelta, setPointDelta] = useState<string>('10');
  const [pointReason, setPointReason] = useState('');
  const [pointRoomId, setPointRoomId] = useState('');
  const [isAdjustingPoints, setIsAdjustingPoints] = useState(false);

  // Host recovery code output
  const [issuedRecovery, setIssuedRecovery] = useState<{ presetCode: string; code: string } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (session?.displayName && !claimName) {
      setClaimName(session.displayName);
    }
  }, [session?.displayName, claimName]);

  const fetchSeason = useCallback(async () => {
    if (!seasonCode) return;
    setLoadError(null);
    try {
      const qs = new URLSearchParams();
      if (monthFilter) qs.set('month', monthFilter);
      if (roomFilter) qs.set('roomCode', roomFilter);
      const query = qs.toString() ? `?${qs.toString()}` : '';
      const res: any = await api.get(`/seasons/${encodeURIComponent(seasonCode)}${query}`);
      const data = res.data as SeasonDetailDto;
      setSeason(data);
      if (!pointEntryId && data.leaderboard.length > 0) {
        setPointEntryId(data.leaderboard[0].entryId);
      }
    } catch (err: any) {
      setLoadError(err?.message || 'Unable to load season.');
    } finally {
      setIsLoading(false);
    }
  }, [seasonCode, monthFilter, roomFilter, pointEntryId]);

  useEffect(() => {
    if (!isHydrated) return;
    fetchSeason();
  }, [isHydrated, fetchSeason]);

  // Real-time Socket.IO season leaderboard sync (no refresh required)
  useEffect(() => {
    if (!token || !seasonCode) return;
    const socket = getRoomSocket(token);
    const joinSeasonChannel = () => {
      socket.emit(SOCKET_EVENTS.SEASON_JOIN, { seasonCode }, () => {});
    };
    const onLeaderboardUpdated = (evt: any) => {
      if (evt?.seasonCode !== seasonCode) return;
      if (monthFilter || roomFilter) {
        fetchSeason();
      } else {
        setSeason((prev) =>
          prev
            ? {
                ...prev,
                status: evt.status ?? prev.status,
                leaderboard: evt.leaderboard ?? prev.leaderboard,
                pointHistory: evt.pointHistory ?? prev.pointHistory,
                auctions: evt.auctions ?? prev.auctions,
                availableMonths: evt.availableMonths ?? prev.availableMonths
              }
            : prev
        );
      }
    };

    socket.on('connect', joinSeasonChannel);
    socket.on(SOCKET_EVENTS.SEASON_LEADERBOARD_UPDATED, onLeaderboardUpdated);
    if (socket.connected) joinSeasonChannel();

    return () => {
      socket.off('connect', joinSeasonChannel);
      socket.off(SOCKET_EVENTS.SEASON_LEADERBOARD_UPDATED, onLeaderboardUpdated);
    };
  }, [token, seasonCode, monthFilter, roomFilter, fetchSeason]);

  const mySeasonFranchise = useMemo(
    () => season?.leaderboard.find((row) => row.isOwnedByRequester) || null,
    [season]
  );

  const handleClaimIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionErr(null);
    setActionMsg(null);
    const trimmed = claimName.trim();
    if (trimmed.length < 2) {
      setActionErr('Enter your display name (at least 2 characters) to continue.');
      return;
    }
    setIsClaiming(true);
    try {
      await ensureSession(trimmed);
      const res: any = await api.post(`/seasons/${seasonCode}/claim`, {
        franchiseCode: claimCode,
        customSuffix: claimSuffix.trim() || undefined,
        displayName: trimmed,
        recoveryCode: recoveryTokenInput.trim() || undefined
      });
      setSeason(res.data);
      setRecoveryTokenInput('');
      setActionMsg(`Season identity locked to ${claimCode}. Your points carry across every auction in this season.`);
    } catch (err: any) {
      setActionErr(err?.message || 'Unable to claim franchise in season.');
    } finally {
      setIsClaiming(false);
    }
  };

  const handleCreateMonthlyAuction = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionErr(null);
    setActionMsg(null);
    if (!roomName.trim() || roomName.trim().length < 3) {
      setActionErr('Auction name must be at least 3 characters.');
      return;
    }
    setIsCreatingRoom(true);
    try {
      const res: any = await api.post(`/seasons/${seasonCode}/rooms`, {
        roomName: roomName.trim(),
        franchiseCode: hostFranchiseCode,
        visibility: RoomVisibility.PUBLIC,
        auctionMode: roomMode,
        seasonMonthLabel: monthLabel.trim() || undefined,
        seasonMonthKey: monthKey.trim() || undefined
      });
      const createdRoom = res.data;
      setRoomName('');
      router.push(`/room/${createdRoom.code}`);
    } catch (err: any) {
      setActionErr(err?.message || 'Unable to create season auction.');
    } finally {
      setIsCreatingRoom(false);
    }
  };

  const handleAdjustPoints = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionErr(null);
    setActionMsg(null);
    const delta = Number(pointDelta);
    if (!Number.isInteger(delta) || delta === 0) {
      setActionErr('Points delta must be a positive or negative non-zero integer.');
      return;
    }
    if (pointReason.trim().length < 3) {
      setActionErr('Mandatory reason required (at least 3 characters) for point adjustments.');
      return;
    }
    setIsAdjustingPoints(true);
    try {
      const res: any = await api.post(`/seasons/${seasonCode}/points`, {
        entryId: pointEntryId,
        pointsDelta: delta,
        reason: pointReason.trim(),
        roomId: pointRoomId || null,
        monthKey: monthFilter || null
      });
      setSeason(res.data);
      setPointReason('');
      setActionMsg(`Leaderboard updated (${delta > 0 ? `+${delta}` : delta} pts) and synced to all connected participants.`);
    } catch (err: any) {
      setActionErr(err?.message || 'Unable to adjust season points.');
    } finally {
      setIsAdjustingPoints(false);
    }
  };

  const handleIssueRecovery = async (entryId: string) => {
    setActionErr(null);
    try {
      const res: any = await api.post(`/seasons/${seasonCode}/entries/${entryId}/recovery-code`, {});
      setIssuedRecovery({ presetCode: res.data.presetCode, code: res.data.recoveryCode });
    } catch (err: any) {
      setActionErr(err?.message || 'Unable to issue recovery code.');
    }
  };

  const handleReleaseSeat = async (entryId: string) => {
    setActionErr(null);
    try {
      const res: any = await api.post(`/seasons/${seasonCode}/entries/${entryId}/release`, {});
      setSeason(res.data);
      setActionMsg('Season franchise controller seat released cleanly.');
    } catch (err: any) {
      setActionErr(err?.message || 'Unable to release franchise.');
    }
  };

  const handleToggleArchive = async () => {
    if (!season) return;
    setActionErr(null);
    try {
      const endpoint =
        season.status === SeasonStatus.ACTIVE
          ? `/seasons/${seasonCode}/archive`
          : `/seasons/${seasonCode}/reopen`;
      const res: any = await api.patch(endpoint, {});
      setSeason(res.data);
      setActionMsg(
        res.data.status === SeasonStatus.ARCHIVED
          ? 'Season archived. All standings and auction records remain preserved.'
          : 'Season reopened cleanly.'
      );
    } catch (err: any) {
      setActionErr(err?.message || 'Unable to change season status.');
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stadium-bg px-4">
        <Card className="p-8 text-center space-y-3 max-w-md w-full">
          <div className="w-10 h-10 rounded-full border-2 border-gold-400 border-t-transparent animate-spin mx-auto" />
          <p className="font-display text-xl text-white">LOADING SEASON STANDINGS...</p>
        </Card>
      </div>
    );
  }

  if (loadError || !season) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stadium-bg px-4">
        <Card className="p-8 text-center space-y-4 max-w-md w-full">
          <h1 className="font-display text-2xl font-bold text-white">SEASON NOT FOUND</h1>
          <p className="text-sm text-stadium-muted">{loadError || 'Unable to open requested season.'}</p>
          <Link href="/seasons">
            <Button variant="gold">Back to Seasons Hub</Button>
          </Link>
        </Card>
      </div>
    );
  }

  const isArchived = season.status === SeasonStatus.ARCHIVED;

  return (
    <div className="min-h-screen bg-stadium-bg pb-16">
      <header className="sticky top-0 z-30 border-b border-stadium-border bg-stadium-bg/90 backdrop-blur-lg">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 min-h-16 py-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/seasons"
              className="p-2 rounded-lg text-stadium-muted hover:text-white hover:bg-white/5"
              aria-label="Back to Seasons"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Trophy className="w-5 h-5 text-gold-400 shrink-0" />
                <h1
                  className="font-display text-xl sm:text-2xl font-extrabold text-white truncate"
                  data-testid="season-title"
                >
                  {season.name}
                </h1>
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-gold-500/15 text-gold-300 border border-gold-500/35">
                  {season.code}
                </span>
                <Badge tone={isArchived ? 'neutral' : 'sold'} data-testid="season-status-badge">
                  {season.status}
                </Badge>
                {season.isHost && (
                  <Badge tone="electric">
                    <Crown className="w-3 h-3" /> Season Host
                  </Badge>
                )}
              </div>
              {season.description && (
                <p className="text-xs text-stadium-muted truncate max-w-2xl mt-0.5">{season.description}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="surface"
              size="sm"
              onClick={async () => {
                const ok = await copyTextSafely(season.code);
                if (ok) {
                  setActionMsg(`Season code ${season.code} copied!`);
                } else {
                  setActionErr(`Copy failed — share season code manually: ${season.code}`);
                }
              }}
              data-testid="copy-season-code-btn"
              leftIcon={<Copy className="w-3.5 h-3.5" />}
            >
              {season.code}
            </Button>
            <Button
              variant="surface"
              size="sm"
              onClick={async () => {
                setActionErr(null);
                const inviteUrl = buildSeasonInviteUrl(season.code);
                const res = await shareInviteLink({
                  title: `${season.name} (${season.code}) | AuctionCraze Season`,
                  text: `Join ${season.name} (${season.code}) on AuctionCraze to claim your franchise and view standings!`,
                  url: inviteUrl
                });
                if (res.outcome === 'shared' || res.outcome === 'copied') {
                  setCopiedCode(true);
                  setTimeout(() => setCopiedCode(false), 1800);
                  setActionMsg(res.message);
                } else if (res.outcome === 'failed') {
                  setActionErr(res.message);
                }
              }}
              data-testid="share-season-link-btn"
              leftIcon={<Copy className="w-3.5 h-3.5" />}
            >
              {copiedCode ? 'Invite Link Copied' : 'Share Season Link'}
            </Button>
            {season.isHost && (
              <Button
                variant={isArchived ? 'electric' : 'danger'}
                size="sm"
                onClick={handleToggleArchive}
                data-testid="toggle-archive-season-btn"
                leftIcon={isArchived ? <RefreshCw className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
              >
                {isArchived ? 'Reopen Season' : 'Archive Season'}
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 space-y-6">
        {actionMsg && (
          <div
            data-testid="season-action-success"
            className="rounded-xl border border-signal-sold/40 bg-signal-sold/10 px-4 py-2.5 text-sm text-signal-sold flex items-center gap-2"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {actionMsg}
          </div>
        )}
        {actionErr && (
          <div
            data-testid="season-action-error"
            className="rounded-xl border border-signal-unsold/40 bg-signal-unsold/10 px-4 py-2.5 text-sm text-signal-unsold"
          >
            {actionErr}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* LEFT / MAIN: Cumulative Season Leaderboard + Immutable Point Audit Log */}
          <div className="xl:col-span-8 space-y-6">
            <Card highlight="gold" className="p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stadium-border pb-3">
                <div>
                  <h2 className="font-display text-2xl font-bold text-white tracking-wide">
                    FRANCHISE SEASON LEADERBOARD
                  </h2>
                  <p className="text-xs text-stadium-muted">
                    Cumulative points across {season.auctionCount} auction(s) • Points are strictly host-awarded, independent of player purchase prices.
                  </p>
                </div>

                {/* Filters: Entire Season / Month / Individual Auction */}
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={monthFilter}
                    onChange={(e) => setMonthFilter(e.target.value)}
                    data-testid="leaderboard-month-filter"
                    className="rounded-xl bg-stadium-bg border border-stadium-border px-3 py-1.5 text-xs text-white focus:outline-none focus:border-gold-400"
                  >
                    <option value="">All Months (Entire Season)</option>
                    {season.availableMonths.map((m) => (
                      <option key={m} value={m}>
                        Month: {m}
                      </option>
                    ))}
                  </select>
                  <select
                    value={roomFilter}
                    onChange={(e) => setRoomFilter(e.target.value)}
                    data-testid="leaderboard-auction-filter"
                    className="rounded-xl bg-stadium-bg border border-stadium-border px-3 py-1.5 text-xs text-white focus:outline-none focus:border-gold-400"
                  >
                    <option value="">All Auctions</option>
                    {season.auctions.map((a) => (
                      <option key={a.id} value={a.code}>
                        {a.name} ({a.code})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse" data-testid="season-leaderboard-table">
                  <thead>
                    <tr className="border-b border-stadium-border text-[11px] uppercase tracking-wider text-stadium-muted">
                      <th className="py-2.5 pr-3">Rank</th>
                      <th className="py-2.5 pr-3">Franchise</th>
                      <th className="py-2.5 pr-3">Auctions</th>
                      <th className="py-2.5 pr-3">Breakdown</th>
                      <th className="py-2.5 pr-3 text-right">Points</th>
                      {season.isHost && <th className="py-2.5 text-right">Recovery</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stadium-border/60 text-sm">
                    {season.leaderboard.map((row) => (
                      <tr
                        key={row.entryId}
                        data-testid={`leaderboard-row-${row.presetCode}`}
                        className={row.isOwnedByRequester ? 'bg-electric-500/10' : 'hover:bg-white/[0.02]'}
                      >
                        <td className="py-3 pr-3 font-mono font-bold text-white whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className={row.rank <= 3 ? 'text-gold-300' : 'text-white'}>#{row.rank}</span>
                            {row.rankMovement > 0 ? (
                              <span className="inline-flex items-center text-[10px] text-signal-sold font-semibold">
                                <ArrowUp className="w-3 h-3" />
                                {row.rankMovement}
                              </span>
                            ) : row.rankMovement < 0 ? (
                              <span className="inline-flex items-center text-[10px] text-signal-unsold font-semibold">
                                <ArrowDown className="w-3 h-3" />
                                {Math.abs(row.rankMovement)}
                              </span>
                            ) : (
                              <Minus className="w-3 h-3 text-stadium-muted/60" />
                            )}
                          </div>
                        </td>
                        <td className="py-3 pr-3">
                          <div className="flex items-center gap-2.5">
                            <FranchiseEmblem
                              code={row.presetCode}
                              primaryColor={row.primaryColor}
                              secondaryColor={row.secondaryColor}
                              size="sm"
                            />
                            <div>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-display font-bold text-white">{row.name}</span>
                                {row.customSuffix && (
                                  <Badge tone="gold">{row.customSuffix}</Badge>
                                )}
                                {row.isOwnedByRequester && (
                                  <Badge tone="electric">YOUR FRANCHISE</Badge>
                                )}
                              </div>
                              <p className="text-[11px] text-stadium-muted">
                                {row.controllerDisplayName
                                  ? `Controlled by ${row.controllerDisplayName}`
                                  : 'Open in season'}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 pr-3 font-mono text-xs text-stadium-text">
                          {row.auctionsParticipated}
                        </td>
                        <td className="py-3 pr-3">
                          <div className="flex flex-wrap gap-1.5">
                            {row.pointsByAuction.length === 0 ? (
                              <span className="text-[11px] text-stadium-muted">—</span>
                            ) : (
                              row.pointsByAuction.map((b, i) => (
                                <span
                                  key={`${b.roomId || 'g'}-${b.monthKey || i}`}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-stadium-card border border-stadium-border text-[10px] font-mono text-stadium-text"
                                >
                                  <span>{b.roomName || b.monthKey || 'Season Adj'}:</span>
                                  <strong className={b.points >= 0 ? 'text-signal-sold' : 'text-signal-unsold'}>
                                    {b.points >= 0 ? `+${b.points}` : b.points}
                                  </strong>
                                </span>
                              ))
                            )}
                          </div>
                        </td>
                        <td
                          className="py-3 pr-3 text-right font-mono text-base font-extrabold text-gold-300"
                          data-testid={`leaderboard-points-${row.presetCode}`}
                        >
                          {monthFilter || roomFilter ? row.filteredPoints : row.totalPoints}
                        </td>
                        {season.isHost && (
                          <td className="py-3 text-right whitespace-nowrap space-x-1">
                            <button
                              type="button"
                              onClick={() => handleIssueRecovery(row.entryId)}
                              data-testid={`issue-recovery-${row.presetCode}`}
                              title="Issue 1-time recovery token"
                              className="px-2 py-1 rounded border border-stadium-border hover:border-electric-400 text-[10px] text-electric-300"
                            >
                              <KeyRound className="w-3 h-3 inline mr-0.5" /> Key
                            </button>
                            {row.isClaimedInSeason && (
                              <button
                                type="button"
                                onClick={() => handleReleaseSeat(row.entryId)}
                                data-testid={`release-entry-${row.presetCode}`}
                                className="px-2 py-1 rounded border border-stadium-border hover:border-signal-unsold text-[10px] text-stadium-muted hover:text-signal-unsold"
                              >
                                Release
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {issuedRecovery && (
                <div
                  data-testid="issued-recovery-banner"
                  className="rounded-xl border border-electric-400/50 bg-electric-500/15 px-4 py-3 text-xs text-white flex flex-wrap items-center justify-between gap-2"
                >
                  <span>
                    One-time Recovery Code for <strong>{issuedRecovery.presetCode}</strong>:{' '}
                    <code className="font-mono font-bold text-gold-300 text-sm px-2 py-0.5 rounded bg-stadium-bg">
                      {issuedRecovery.code}
                    </code>
                  </span>
                  <span className="text-stadium-muted">Share privately with the franchise owner to reclaim lost browser state.</span>
                </div>
              )}
            </Card>

            {/* Point Audit History */}
            <Card className="p-5 space-y-3">
              <div className="flex items-center justify-between border-b border-stadium-border pb-2.5">
                <h2 className="font-display text-lg font-bold text-white flex items-center gap-2">
                  <History className="w-4 h-4 text-electric-400" />
                  COMPLETE POINT AUDIT HISTORY
                </h2>
                <span className="text-xs font-mono text-stadium-muted">{season.pointHistory.length} entries</span>
              </div>

              {season.pointHistory.length === 0 ? (
                <p className="text-xs text-stadium-muted py-4 text-center">
                  No point adjustments recorded yet. Host adjustments appear here permanently with mandatory reasons.
                </p>
              ) : (
                <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1" data-testid="season-point-history">
                  {season.pointHistory.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-stadium-border bg-stadium-card/70 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white">{item.franchiseDisplayName}</span>
                          <span
                            className={`font-mono font-bold px-2 py-0.5 rounded ${
                              item.pointsDelta >= 0
                                ? 'bg-signal-sold/15 text-signal-sold'
                                : 'bg-signal-unsold/15 text-signal-unsold'
                            }`}
                          >
                            {item.pointsDelta >= 0 ? `+${item.pointsDelta}` : item.pointsDelta} pts
                          </span>
                          <span className="text-stadium-muted font-mono">
                            → Total {item.balanceAfter}
                          </span>
                        </div>
                        <p className="text-stadium-text">Reason: {item.reason}</p>
                      </div>
                      <div className="text-right text-[11px] text-stadium-muted font-mono">
                        <p>
                          By {item.adjustedByName}
                          {item.roomName ? ` • ${item.roomName}` : item.monthKey ? ` • ${item.monthKey}` : ''}
                        </p>
                        <p>{new Date(item.createdAt).toLocaleString()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* RIGHT RAIL: Identity Selector + Season Auctions + Host Controls */}
          <div className="xl:col-span-4 space-y-5">
            {/* Returning / Login-Free Franchise Identity */}
            <Card highlight="electric" className="p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-stadium-border pb-2.5">
                <h2 className="font-display text-lg font-bold text-white flex items-center gap-2">
                  <UserCheck className="w-4 h-4 text-electric-400" />
                  FRANCHISE IDENTITY (NO LOGIN)
                </h2>
              </div>

              {mySeasonFranchise ? (
                <div
                  data-testid="returning-franchise-card"
                  className="rounded-xl border border-electric-400/50 bg-electric-500/10 p-3.5 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-display font-bold text-white text-base">
                      {mySeasonFranchise.displayName}
                    </span>
                    <Badge tone="gold">{mySeasonFranchise.totalPoints} pts</Badge>
                  </div>
                  <p className="text-xs text-stadium-muted">
                    Returning Season Identity active ({mySeasonFranchise.auctionsParticipated} auction(s) joined). Join any open auction below with your franchise!
                  </p>
                </div>
              ) : (
                <p className="text-xs text-stadium-muted">
                  Claim an open franchise in this season or enter a Host recovery code to restore your franchise history.
                </p>
              )}

              {!isArchived && (
                <form onSubmit={handleClaimIdentity} className="space-y-3">
                  <Input
                    label="Display Name"
                    value={claimName}
                    onChange={(e) => setClaimName(e.target.value)}
                    placeholder="Your owner name"
                    data-testid="season-claim-name-input"
                    required
                  />
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted mb-1">
                      Select Franchise
                    </label>
                    <select
                      value={claimCode}
                      onChange={(e) => setClaimCode(e.target.value)}
                      data-testid="season-claim-franchise-select"
                      className="w-full rounded-xl bg-stadium-bg border border-stadium-border px-3 py-2 text-sm text-white focus:outline-none focus:border-electric-400"
                    >
                      {IPL_FRANCHISE_PRESETS.map((p) => (
                        <option key={p.code} value={p.code}>
                          {p.shortName} — {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Input
                    label="Custom Team Suffix (Optional)"
                    value={claimSuffix}
                    onChange={(e) => setClaimSuffix(e.target.value)}
                    maxLength={24}
                    placeholder="e.g. Titans XI"
                    data-testid="season-claim-suffix-input"
                  />
                  <Input
                    label="Recovery Code (Only if reclaiming lost session)"
                    value={recoveryTokenInput}
                    onChange={(e) => setRecoveryTokenInput(e.target.value.toUpperCase())}
                    placeholder="REC-XXXXXX"
                    data-testid="season-recovery-code-input"
                  />
                  <Button
                    type="submit"
                    variant="electric"
                    className="w-full"
                    isLoading={isClaiming}
                    data-testid="season-claim-submit-btn"
                  >
                    {mySeasonFranchise ? 'Update / Claim Franchise Identity' : 'Claim Franchise Without Login'}
                  </Button>
                </form>
              )}
            </Card>

            {/* Monthly / Individual Auctions in this Season */}
            <Card className="p-5 space-y-3">
              <div className="flex items-center justify-between border-b border-stadium-border pb-2.5">
                <h2 className="font-display text-lg font-bold text-white flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-gold-400" />
                  SEASON AUCTIONS ({season.auctions.length})
                </h2>
              </div>

              {season.auctions.length === 0 ? (
                <p className="text-xs text-stadium-muted py-3 text-center">
                  No monthly or individual auctions scheduled yet.
                </p>
              ) : (
                <div className="space-y-2.5 max-h-[260px] overflow-y-auto pr-1" data-testid="season-auctions-list">
                  {season.auctions.map((a) => (
                    <Link
                      key={a.id}
                      href={`/room/${a.code}`}
                      data-testid={`season-auction-${a.code}`}
                      className="block rounded-xl border border-stadium-border bg-stadium-card/70 hover:border-gold-400/50 p-3 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-sm text-white truncate">{a.name}</span>
                        <Badge tone={a.status === 'COMPLETED' ? 'sold' : 'electric'}>{a.status}</Badge>
                      </div>
                      <div className="flex items-center justify-between text-[11px] font-mono text-stadium-muted mt-1">
                        <span>{a.seasonMonthLabel || a.seasonMonthKey || a.auctionMode}</span>
                        <span className="text-gold-300">{a.code} • {a.occupiedFranchises}/10 teams</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Card>

            {/* HOST ONLY: Point Adjustment + Create Monthly Auction */}
            {season.isHost && !isArchived && (
              <>
                <Card highlight="gold" className="p-5 space-y-4" data-testid="host-point-management-card">
                  <div className="flex items-center gap-2 border-b border-stadium-border pb-2.5">
                    <Shield className="w-4 h-4 text-gold-400" />
                    <h2 className="font-display text-lg font-bold text-white">HOST POINT MANAGEMENT</h2>
                  </div>

                  <form onSubmit={handleAdjustPoints} className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted mb-1">
                        Franchise
                      </label>
                      <select
                        value={pointEntryId}
                        onChange={(e) => setPointEntryId(e.target.value)}
                        data-testid="point-franchise-select"
                        className="w-full rounded-xl bg-stadium-bg border border-stadium-border px-3 py-2 text-sm text-white focus:outline-none focus:border-gold-400"
                      >
                        {season.leaderboard.map((r) => (
                          <option key={r.entryId} value={r.entryId}>
                            {r.presetCode} — {r.displayName} ({r.totalPoints} pts)
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <Input
                        label="Points Delta (+/-)"
                        type="number"
                        value={pointDelta}
                        onChange={(e) => setPointDelta(e.target.value)}
                        placeholder="+10 or -5"
                        data-testid="point-delta-input"
                        required
                      />
                      <div>
                        <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted mb-1">
                          Auction Tag (Opt.)
                        </label>
                        <select
                          value={pointRoomId}
                          onChange={(e) => setPointRoomId(e.target.value)}
                          data-testid="point-room-select"
                          className="w-full rounded-xl bg-stadium-bg border border-stadium-border px-3 py-2 text-xs text-white focus:outline-none focus:border-gold-400"
                        >
                          <option value="">General Season</option>
                          {season.auctions.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <Input
                      label="Mandatory Adjustment Reason"
                      value={pointReason}
                      onChange={(e) => setPointReason(e.target.value)}
                      maxLength={200}
                      placeholder="e.g. Monthly tournament winner bonus"
                      data-testid="point-reason-input"
                      required
                    />

                    <Button
                      type="submit"
                      variant="gold"
                      className="w-full"
                      isLoading={isAdjustingPoints}
                      data-testid="submit-point-adjustment-btn"
                    >
                      Apply Point Adjustment
                    </Button>
                  </form>
                </Card>

                <Card className="p-5 space-y-4" data-testid="host-create-season-auction-card">
                  <div className="flex items-center gap-2 border-b border-stadium-border pb-2.5">
                    <Plus className="w-4 h-4 text-electric-400" />
                    <h2 className="font-display text-lg font-bold text-white">CREATE SEASON AUCTION</h2>
                  </div>

                  <form onSubmit={handleCreateMonthlyAuction} className="space-y-3">
                    <Input
                      label="Auction Title"
                      value={roomName}
                      onChange={(e) => setRoomName(e.target.value)}
                      placeholder="e.g. November Auction"
                      data-testid="season-room-name-input"
                      required
                    />
                    <div className="grid grid-cols-2 gap-2.5">
                      <Input
                        label="Month Label"
                        value={monthLabel}
                        onChange={(e) => setMonthLabel(e.target.value)}
                        placeholder="November Auction"
                        data-testid="season-room-month-label-input"
                      />
                      <Input
                        label="Month (YYYY-MM)"
                        value={monthKey}
                        onChange={(e) => setMonthKey(e.target.value)}
                        placeholder="2026-11"
                        data-testid="season-room-month-key-input"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted mb-1">
                          Your Franchise
                        </label>
                        <select
                          value={hostFranchiseCode}
                          onChange={(e) => setHostFranchiseCode(e.target.value)}
                          data-testid="season-room-franchise-select"
                          className="w-full rounded-xl bg-stadium-bg border border-stadium-border px-3 py-2 text-xs text-white"
                        >
                          {IPL_FRANCHISE_PRESETS.map((p) => (
                            <option key={p.code} value={p.code}>
                              {p.shortName}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted mb-1">
                          Mode
                        </label>
                        <select
                          value={roomMode}
                          onChange={(e) => setRoomMode(e.target.value as AuctionMode)}
                          className="w-full rounded-xl bg-stadium-bg border border-stadium-border px-3 py-2 text-xs text-white"
                        >
                          <option value={AuctionMode.MOCK}>MOCK</option>
                          <option value={AuctionMode.MEGA}>MEGA</option>
                          <option value={AuctionMode.CUSTOM}>CUSTOM</option>
                        </select>
                      </div>
                    </div>
                    <Button
                      type="submit"
                      variant="electric"
                      className="w-full"
                      isLoading={isCreatingRoom}
                      data-testid="create-season-room-btn"
                    >
                      Launch Auction Room
                    </Button>
                  </form>
                </Card>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { IPL_FRANCHISE_PRESETS } from '@auctioncraze/shared';
import { api } from '@/lib/api';
import { useSessionStore } from '@/stores/sessionStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FranchiseEmblem } from '@/components/ui/FranchiseEmblem';
import { PlayerProfileModal } from '@/components/players/PlayerProfileModal';
import {
  Activity,
  ArrowLeft,
  Award,
  Lock,
  ShieldCheck,
  Sparkles,
  Trophy
} from 'lucide-react';

const ACTIVE_TEAMS = IPL_FRANCHISE_PRESETS.map((f) => ({
  code: f.code,
  name: f.name,
  primaryColor: f.primaryColor,
  secondaryColor: f.secondaryColor
}));

interface OwnerAccessState {
  authorized: boolean;
  roomCode: string;
  role: string;
  franchiseId: string;
  franchiseCode: string;
  franchiseName: string;
}

function OwnerIntelligenceContent() {
  const searchParams = useSearchParams();
  const roomCode = (searchParams.get('roomCode') || '').trim().toUpperCase();
  const { token, isHydrated, hydrate } = useSessionStore();

  const [access, setAccess] = useState<OwnerAccessState | null>(null);
  const [accessChecking, setAccessChecking] = useState(true);
  const [accessDeniedReason, setAccessDeniedReason] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'MATCH' | 'LEADERBOARD'>('MATCH');

  // Match Predictor State
  const [meta, setMeta] = useState<any | null>(null);
  const [homeCode, setHomeCode] = useState('CSK');
  const [awayCode, setAwayCode] = useState('MI');
  const [venue, setVenue] = useState('MA Chidambaram Stadium, Chepauk');
  const [tossWinner, setTossWinner] = useState('');
  const [tossDecision, setTossDecision] = useState('');
  const [matchPred, setMatchPred] = useState<any | null>(null);
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);

  // Leaderboard State
  const [roleFilter, setRoleFilter] = useState('ALL');
  const [scopeFilter, setScopeFilter] = useState<'CAREER' | 'RECENT_3_SEASONS'>('CAREER');
  const [sortBy, setSortBy] = useState('overall_rating');
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [lbLoading, setLbLoading] = useState(false);
  const [lbError, setLbError] = useState<string | null>(null);
  const [mlDisabledNotice, setMlDisabledNotice] = useState<string | null>(null);
  const [modalPlayerId, setModalPlayerId] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!isHydrated) return;

    if (!roomCode) {
      setAccess(null);
      setAccessDeniedReason(
        'A valid auction room code (?roomCode=...) is required to verify franchise ownership.'
      );
      setAccessChecking(false);
      return;
    }

    if (!token) {
      setAccess(null);
      setAccessDeniedReason('Sign in with an active guest session and claim a franchise to continue.');
      setAccessChecking(false);
      return;
    }

    let cancelled = false;
    setAccessChecking(true);
    setAccessDeniedReason(null);

    api
      .get(`/intelligence/rooms/${encodeURIComponent(roomCode)}/access`)
      .then((res: any) => {
        if (!cancelled) {
          setAccess(res.data as OwnerAccessState);
          if (res.data?.franchiseCode) {
            setHomeCode(res.data.franchiseCode);
            setAwayCode(res.data.franchiseCode === 'MI' ? 'CSK' : 'MI');
          }
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setAccess(null);
          setAccessDeniedReason(
            err?.message || 'Access denied: only active franchise owners can access this workspace.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setAccessChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isHydrated, token, roomCode]);

  useEffect(() => {
    if (!access?.authorized) return;

    api
      .get(`/intelligence/rooms/${encodeURIComponent(access.roomCode)}/match-predictor/metadata`)
      .then((res: any) => {
        setMeta(res.data);
        if (res.data?.venues?.length && !res.data.venues.includes(venue)) {
          setVenue(res.data.venues[0]);
        }
      })
      .catch((err: any) => {
        if (err?.code === 'ML_SERVICE_DISABLED') {
          setMlDisabledNotice(err.message);
        }
      });
  }, [access]);

  useEffect(() => {
    if (!access?.authorized) return;

    setLbLoading(true);
    setLbError(null);
    const qs = new URLSearchParams({
      scope: scopeFilter,
      sort_by: sortBy,
      limit: '25',
      min_matches: scopeFilter === 'RECENT_3_SEASONS' ? '5' : '15'
    });
    if (roleFilter !== 'ALL') {
      qs.set('role', roleFilter);
    }

    api
      .get(
        `/intelligence/rooms/${encodeURIComponent(access.roomCode)}/ratings/leaderboard?${qs.toString()}`
      )
      .then((res: any) => setLeaderboard(res.data?.players || []))
      .catch((err: any) => {
        if (err?.code === 'ML_SERVICE_DISABLED') {
          setMlDisabledNotice(err.message);
        }
        setLbError(err?.message || 'Unable to load ratings leaderboard.');
      })
      .finally(() => setLbLoading(false));
  }, [access, roleFilter, scopeFilter, sortBy]);

  const handlePredictMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!access?.authorized) return;
    setMatchError(null);
    if (homeCode === awayCode) {
      setMatchError('Select two distinct franchises for match comparison.');
      return;
    }
    setMatchLoading(true);
    try {
      const res: any = await api.post(
        `/intelligence/rooms/${encodeURIComponent(access.roomCode)}/match-predictor/predict`,
        {
          home_franchise_code: homeCode,
          away_franchise_code: awayCode,
          venue,
          home_xi: [],
          away_xi: [],
          toss_winner: tossWinner || null,
          toss_decision: tossDecision || null
        }
      );
      setMatchPred(res.data);
    } catch (err: any) {
      setMatchError(err?.message || 'Match prediction failed.');
    } finally {
      setMatchLoading(false);
    }
  };

  useEffect(() => {
    if (!access?.authorized || !meta || matchPred) return;
    api
      .post(
        `/intelligence/rooms/${encodeURIComponent(access.roomCode)}/match-predictor/predict`,
        {
          home_franchise_code: homeCode,
          away_franchise_code: awayCode,
          venue,
          home_xi: [],
          away_xi: []
        }
      )
      .then((res: any) => setMatchPred(res.data))
      .catch(() => {});
  }, [access, meta]);

  if (!isHydrated || accessChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stadium-canvas p-6">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-electric-400 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-stadium-muted">Verifying franchise owner authorization...</p>
        </div>
      </div>
    );
  }

  if (!access?.authorized) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-stadium-canvas p-6"
        data-testid="intelligence-access-denied"
      >
        <Card className="max-w-lg w-full p-7 text-center space-y-4 border-amber-500/40">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/35 text-amber-400 flex items-center justify-center mx-auto">
            <Lock className="w-6 h-6" />
          </div>
          <div className="space-y-1.5">
            <Badge tone="unsold">FRANCHISE OWNERS ONLY</Badge>
            <h1 className="font-display text-2xl font-extrabold text-white tracking-wide mt-2">
              CRICKET INTELLIGENCE RESTRICTED
            </h1>
            <p className="text-xs text-stadium-muted leading-relaxed">
              {accessDeniedReason ||
                'Advanced cricket intelligence and ratings are restricted to verified franchise owners inside an auction room. Public visitors and spectators can browse standard IPL profiles in the Player Archive.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <Link href="/">
              <Button variant="surface" size="sm">
                <ArrowLeft className="w-3.5 h-3.5" /> Return to Arena
              </Button>
            </Link>
            <Link href="/players">
              <Button variant="electric" size="sm">
                Browse Public Player Archive
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const homeTeamInfo = ACTIVE_TEAMS.find((t) => t.code === homeCode) || ACTIVE_TEAMS[0];
  const awayTeamInfo = ACTIVE_TEAMS.find((t) => t.code === awayCode) || ACTIVE_TEAMS[1];

  return (
    <div className="min-h-screen flex flex-col bg-stadium-canvas">
      <header className="border-b border-stadium-border/80 bg-stadium-bg/85 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link href={`/room/${encodeURIComponent(access.roomCode)}/auction`}>
              <Button variant="surface" size="sm">
                <ArrowLeft className="w-3.5 h-3.5" /> Room {access.roomCode}
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display text-2xl font-extrabold tracking-wide text-white">
                  OWNER <span className="text-electric-400">INTELLIGENCE</span>
                </span>
                <Badge tone="gold">{access.franchiseCode} OWNER</Badge>
              </div>
              <p className="text-[11px] text-stadium-muted -mt-0.5 hidden sm:block">
                Verified Franchise Owner Workspace • {access.franchiseName}
              </p>
            </div>
          </div>

          <Link href="/players">
            <Button variant="surface" size="sm">
              Player Archive
            </Button>
          </Link>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {mlDisabledNotice && (
          <Card className="p-4 border-amber-500/40 bg-amber-500/10" data-testid="ml-disabled-banner">
            <p className="text-sm font-semibold text-amber-300">
              ML Cricket Intelligence Disabled in Zero-Cost Mode
            </p>
            <p className="text-xs text-amber-200/85 mt-1">{mlDisabledNotice}</p>
          </Card>
        )}
        <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-2 text-emerald-200 font-medium">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            Cricket Analytics Only — No auction price targets, buying suggestions, or bidding advice.
          </span>
          <span className="font-mono text-[11px] text-emerald-300">
            Authorized: {access.franchiseCode} ({access.role})
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            data-testid="tab-match-predictor"
            onClick={() => setActiveTab('MATCH')}
            className={`px-4 py-2 rounded-xl text-xs font-bold tracking-wide transition-colors flex items-center gap-2 ${
              activeTab === 'MATCH'
                ? 'bg-electric-500 text-white shadow-lg'
                : 'bg-stadium-card text-stadium-muted border border-stadium-border hover:text-white'
            }`}
          >
            <Sparkles className="w-4 h-4" /> Match Outcome Predictor
          </button>
          <button
            type="button"
            data-testid="tab-ratings-leaderboard"
            onClick={() => setActiveTab('LEADERBOARD')}
            className={`px-4 py-2 rounded-xl text-xs font-bold tracking-wide transition-colors flex items-center gap-2 ${
              activeTab === 'LEADERBOARD'
                ? 'bg-gold-500 text-stadium-bg shadow-lg'
                : 'bg-stadium-card text-stadium-muted border border-stadium-border hover:text-white'
            }`}
          >
            <Trophy className="w-4 h-4" /> Player Ratings Leaderboard
          </button>
        </div>

        {activeTab === 'MATCH' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <Card className="lg:col-span-5 p-5 space-y-4">
              <div className="flex items-center gap-2 border-b border-stadium-border pb-3">
                <Activity className="w-4 h-4 text-electric-400" />
                <h2 className="font-display text-xl font-bold text-white tracking-wide">
                  MATCHUP CONFIGURATION
                </h2>
              </div>

              <form onSubmit={handlePredictMatch} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase text-stadium-muted mb-1">
                      Team A
                    </label>
                    <select
                      value={homeCode}
                      onChange={(e) => setHomeCode(e.target.value)}
                      data-testid="select-home-team"
                      className="w-full rounded-xl bg-stadium-card border border-stadium-border px-3 py-2 text-xs text-white focus:outline-none focus:border-electric-400"
                    >
                      {ACTIVE_TEAMS.map((t) => (
                        <option key={t.code} value={t.code}>
                          {t.code} — {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase text-stadium-muted mb-1">
                      Team B
                    </label>
                    <select
                      value={awayCode}
                      onChange={(e) => setAwayCode(e.target.value)}
                      data-testid="select-away-team"
                      className="w-full rounded-xl bg-stadium-card border border-stadium-border px-3 py-2 text-xs text-white focus:outline-none focus:border-electric-400"
                    >
                      {ACTIVE_TEAMS.map((t) => (
                        <option key={t.code} value={t.code}>
                          {t.code} — {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold uppercase text-stadium-muted mb-1">
                    Venue
                  </label>
                  <select
                    value={venue}
                    onChange={(e) => setVenue(e.target.value)}
                    data-testid="select-venue"
                    className="w-full rounded-xl bg-stadium-card border border-stadium-border px-3 py-2 text-xs text-white focus:outline-none focus:border-electric-400"
                  >
                    {(meta?.venues || [venue]).map((v: string) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase text-stadium-muted mb-1">
                      Toss Winner (Optional)
                    </label>
                    <select
                      value={tossWinner}
                      onChange={(e) => setTossWinner(e.target.value)}
                      className="w-full rounded-xl bg-stadium-card border border-stadium-border px-3 py-2 text-xs text-white focus:outline-none focus:border-electric-400"
                    >
                      <option value="">Unknown / Pre-toss</option>
                      <option value={homeCode}>{homeCode}</option>
                      <option value={awayCode}>{awayCode}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase text-stadium-muted mb-1">
                      Toss Decision
                    </label>
                    <select
                      value={tossDecision}
                      onChange={(e) => setTossDecision(e.target.value)}
                      disabled={!tossWinner}
                      className="w-full rounded-xl bg-stadium-card border border-stadium-border px-3 py-2 text-xs text-white disabled:opacity-50 focus:outline-none focus:border-electric-400"
                    >
                      <option value="">—</option>
                      <option value="field">Field first</option>
                      <option value="bat">Bat first</option>
                    </select>
                  </div>
                </div>

                {matchError && <p className="text-xs text-signal-unsold font-semibold">{matchError}</p>}

                <Button
                  type="submit"
                  variant="electric"
                  className="w-full"
                  disabled={matchLoading}
                  data-testid="run-match-prediction-btn"
                >
                  {matchLoading ? 'Running Calibrated Forecast...' : 'Predict Win Probability'}
                </Button>
              </form>
            </Card>

            <Card highlight="electric" className="lg:col-span-7 p-6 space-y-5" data-testid="match-prediction-result">
              {!matchPred ? (
                <div className="py-12 text-center text-sm text-stadium-muted">
                  Configure a fixture on the left to compute calibrated win probabilities.
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge tone="electric">CALIBRATED FORECAST • v{matchPred.model_version}</Badge>
                    <span className="text-[11px] font-mono text-stadium-muted">{matchPred.venue}</span>
                  </div>

                  <div className="grid grid-cols-3 items-center gap-3 py-2">
                    <div className="flex items-center gap-3">
                      <FranchiseEmblem
                        code={homeTeamInfo.code}
                        primaryColor={homeTeamInfo.primaryColor}
                        secondaryColor={homeTeamInfo.secondaryColor}
                      />
                      <div>
                        <p className="text-xs text-stadium-muted">{homeTeamInfo.name}</p>
                        <p className="font-mono text-2xl font-extrabold text-gold-300">
                          {(matchPred.home_win_probability * 100).toFixed(1)}%
                        </p>
                      </div>
                    </div>

                    <div className="text-center font-display text-lg font-bold text-stadium-muted">
                      VS
                    </div>

                    <div className="flex items-center justify-end gap-3 text-right">
                      <div>
                        <p className="text-xs text-stadium-muted">{awayTeamInfo.name}</p>
                        <p className="font-mono text-2xl font-extrabold text-electric-400">
                          {(matchPred.away_win_probability * 100).toFixed(1)}%
                        </p>
                      </div>
                      <FranchiseEmblem
                        code={awayTeamInfo.code}
                        primaryColor={awayTeamInfo.primaryColor}
                        secondaryColor={awayTeamInfo.secondaryColor}
                      />
                    </div>
                  </div>

                  <div className="h-3.5 rounded-full overflow-hidden bg-stadium-card flex border border-stadium-border">
                    <div
                      className="bg-gradient-to-r from-gold-500 to-gold-400 transition-all duration-500"
                      style={{ width: `${(matchPred.home_win_probability * 100).toFixed(1)}%` }}
                    />
                    <div
                      className="bg-gradient-to-r from-electric-500 to-electric-400 transition-all duration-500"
                      style={{ width: `${(matchPred.away_win_probability * 100).toFixed(1)}%` }}
                    />
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-stadium-muted">
                      Key Analytical Signals
                    </h3>
                    <ul className="space-y-1.5 text-xs text-white/90">
                      {(matchPred.key_factors || []).map((f: string) => (
                        <li
                          key={f}
                          className="rounded-lg border border-stadium-border/70 bg-stadium-card/50 px-3 py-2"
                        >
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <p className="text-[11px] text-stadium-muted">{matchPred.disclaimer}</p>
                </>
              )}
            </Card>
          </div>
        )}

        {activeTab === 'LEADERBOARD' && (
          <Card className="p-5 space-y-4" data-testid="ratings-leaderboard-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stadium-border pb-4">
              <div>
                <h2 className="font-display text-2xl font-bold text-white flex items-center gap-2">
                  <Award className="w-5 h-5 text-gold-400" />
                  HISTORICAL PERFORMANCE RATINGS LEADERBOARD
                </h2>
                <p className="text-xs text-stadium-muted">
                  Bayesian sample-size shrinkage over verified IPL ball-by-ball records (not official IPL ratings).
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                  className="rounded-lg bg-stadium-card border border-stadium-border px-2.5 py-1.5 text-xs text-white"
                >
                  <option value="ALL">All Roles</option>
                  <option value="BATSMAN">Batsmen</option>
                  <option value="BOWLER">Bowlers</option>
                  <option value="ALL_ROUNDER">All-Rounders</option>
                  <option value="WICKET_KEEPER">Wicketkeepers</option>
                </select>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="rounded-lg bg-stadium-card border border-stadium-border px-2.5 py-1.5 text-xs text-white"
                >
                  <option value="overall_rating">Sort: Overall</option>
                  <option value="batting_rating">Sort: Batting</option>
                  <option value="bowling_rating">Sort: Bowling</option>
                  <option value="all_rounder_rating">Sort: All-Rounder</option>
                  <option value="fielding_rating">Sort: Fielding</option>
                </select>
                <select
                  value={scopeFilter}
                  onChange={(e) => setScopeFilter(e.target.value as any)}
                  className="rounded-lg bg-stadium-card border border-stadium-border px-2.5 py-1.5 text-xs text-white"
                >
                  <option value="CAREER">Full IPL Career</option>
                  <option value="RECENT_3_SEASONS">Recent 3 Seasons</option>
                </select>
              </div>
            </div>

            {lbLoading ? (
              <div className="py-12 text-center text-xs text-stadium-muted">
                Loading historical statistical ratings...
              </div>
            ) : lbError ? (
              <p className="text-xs text-signal-unsold">{lbError}</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-stadium-border">
                <table className="w-full text-left text-xs whitespace-nowrap">
                  <thead className="bg-stadium-bg/85 text-[10px] uppercase tracking-wider text-stadium-muted border-b border-stadium-border">
                    <tr>
                      <th className="px-3 py-2.5">#</th>
                      <th className="px-3 py-2.5">Player</th>
                      <th className="px-3 py-2.5">Role</th>
                      <th className="px-3 py-2.5 text-right">Mat</th>
                      <th className="px-3 py-2.5 text-right">Overall</th>
                      <th className="px-3 py-2.5 text-right">Batting</th>
                      <th className="px-3 py-2.5 text-right">Bowling</th>
                      <th className="px-3 py-2.5 text-right">All-Rounder</th>
                      <th className="px-3 py-2.5 text-right">Fielding</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stadium-border/60 font-mono">
                    {leaderboard.map((p, idx) => (
                      <tr
                        key={p.player_id}
                        onClick={() => setModalPlayerId(p.external_key || p.player_id)}
                        className="cursor-pointer hover:bg-white/[0.04] transition-colors"
                      >
                        <td className="px-3 py-2.5 text-stadium-muted">{idx + 1}</td>
                        <td className="px-3 py-2.5 font-sans font-semibold text-white">
                          {p.full_name} {p.is_overseas && <Badge tone="electric">OS</Badge>}
                        </td>
                        <td className="px-3 py-2.5 font-sans text-stadium-muted">{p.playing_role}</td>
                        <td className="px-3 py-2.5 text-right text-white">{p.sample_matches}</td>
                        <td className="px-3 py-2.5 text-right font-bold text-gold-300">
                          {p.overall_rating?.toFixed(1) ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right text-signal-sold">
                          {p.batting_rating?.toFixed(1) ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right text-electric-400">
                          {p.bowling_rating?.toFixed(1) ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right text-white">
                          {p.all_rounder_rating?.toFixed(1) ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right text-stadium-muted">
                          {p.fielding_rating?.toFixed(1) ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </main>

      <PlayerProfileModal
        playerId={modalPlayerId}
        onClose={() => setModalPlayerId(null)}
        initialTab="INTELLIGENCE"
        intelligenceRoomCode={access.roomCode}
        canViewIntelligence={true}
      />
    </div>
  );
}

export default function CricketIntelligencePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-stadium-canvas text-sm text-stadium-muted">
          Loading Cricket Intelligence...
        </div>
      }
    >
      <OwnerIntelligenceContent />
    </Suspense>
  );
}

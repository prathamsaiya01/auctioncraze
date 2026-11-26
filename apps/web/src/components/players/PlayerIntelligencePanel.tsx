'use client';

import React, { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Activity, BarChart3, Flame, ShieldAlert, TrendingUp } from 'lucide-react';

interface PlayerIntelligencePanelProps {
  playerId: string;
  roomCode: string;
}

function fmt(val: number | null | undefined, suffix = ''): string {
  if (val === null || val === undefined) return '—';
  return `${val}${suffix}`;
}

function RatingCard({
  label,
  value,
  tone = 'gold'
}: {
  label: string;
  value: number | null | undefined;
  tone?: 'gold' | 'electric' | 'sold' | 'neutral';
}) {
  const color =
    tone === 'electric'
      ? 'text-electric-400 border-electric-500/30'
      : tone === 'sold'
      ? 'text-signal-sold border-signal-sold/30'
      : tone === 'neutral'
      ? 'text-white border-stadium-border'
      : 'text-gold-300 border-gold-500/35';

  return (
    <div className={`rounded-xl border bg-stadium-card/70 px-3 py-2.5 text-center ${color}`}>
      <p className="text-[10px] uppercase tracking-wider text-stadium-muted">{label}</p>
      <p className="font-mono text-xl font-extrabold mt-0.5">
        {value !== null && value !== undefined ? value.toFixed(1) : '—'}
      </p>
      <p className="text-[10px] text-stadium-muted font-mono">/ 100</p>
    </div>
  );
}

export function PlayerIntelligencePanel({ playerId, roomCode }: PlayerIntelligencePanelProps) {
  const [scope, setScope] = useState<'CAREER' | 'RECENT_3_SEASONS'>('CAREER');
  const [analytics, setAnalytics] = useState<any | null>(null);
  const [rating, setRating] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomCode) {
      setError('Franchise owner room context is required.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      api.get(`/intelligence/rooms/${roomCode}/players/${playerId}/analytics?scope=${scope}`),
      api.post(`/intelligence/rooms/${roomCode}/players/${playerId}/rating`, { scope })
    ])
      .then(([advRes, ratRes]: any[]) => {
        if (!cancelled) {
          setAnalytics(advRes.data);
          setRating(ratRes.data);
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setError(err?.message || 'Unable to load player cricket intelligence.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [playerId, roomCode, scope]);

  const stats = analytics?.stats;

  return (
    <div className="space-y-5" data-testid="player-intelligence-panel">
      {/* Scope toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setScope('CAREER')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              scope === 'CAREER'
                ? 'bg-gold-500 text-stadium-bg'
                : 'bg-stadium-card text-stadium-muted hover:text-white border border-stadium-border'
            }`}
          >
            Full IPL Career
          </button>
          <button
            type="button"
            onClick={() => setScope('RECENT_3_SEASONS')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              scope === 'RECENT_3_SEASONS'
                ? 'bg-gold-500 text-stadium-bg'
                : 'bg-stadium-card text-stadium-muted hover:text-white border border-stadium-border'
            }`}
          >
            Recent 3 Seasons
          </button>
        </div>

        <Badge tone="neutral">
          Scope Used: {rating?.scope_used || analytics?.scope_used || scope}
        </Badge>
      </div>

      {loading ? (
        <div className="py-10 text-center space-y-2">
          <div className="w-7 h-7 border-2 border-gold-400 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs text-stadium-muted">Computing ball-by-ball splits & statistical ratings...</p>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 text-xs text-amber-200 flex items-start gap-2.5">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <div>
            <p className="font-semibold">Cricket Intelligence Unavailable</p>
            <p className="text-amber-200/80 mt-0.5">{error}</p>
          </div>
        </div>
      ) : (
        <>
          {/* Historical Statistical Ratings */}
          {rating && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-display text-lg font-bold text-white flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-gold-400" />
                  HISTORICAL PERFORMANCE RATINGS
                </h4>
                <span className="text-[10px] font-mono uppercase text-stadium-muted">
                  Sample: {rating.sample_matches} matches
                </span>
              </div>

              {rating.insufficient_sample ? (
                <div className="rounded-xl border border-stadium-border bg-stadium-card/50 p-3 text-xs text-stadium-muted">
                  Insufficient historical IPL sample (&lt; 5 matches) to assign shrunk statistical ratings cleanly.
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                  <RatingCard label="Overall" value={rating.overall_rating} tone="gold" />
                  <RatingCard label="Batting" value={rating.batting_rating} tone="sold" />
                  <RatingCard label="Bowling" value={rating.bowling_rating} tone="electric" />
                  <RatingCard label="All-Rounder" value={rating.all_rounder_rating} tone="neutral" />
                  <RatingCard label="Fielding" value={rating.fielding_rating} tone="neutral" />
                </div>
              )}

              <p className="text-[11px] text-stadium-muted bg-stadium-bg/60 border border-stadium-border/70 rounded-lg px-3 py-2">
                {rating.disclaimer}
              </p>
            </div>
          )}

          {/* Ball-by-ball Batting Over-Phase & Situation Splits */}
          {stats && stats.batting_innings > 0 && (
            <div className="space-y-2.5">
              <h4 className="font-display text-lg font-bold text-white flex items-center gap-2">
                <Flame className="w-4 h-4 text-signal-sold" />
                BATTING PHASE & SITUATION SPLITS
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div className="rounded-xl border border-stadium-border bg-stadium-card/50 p-2.5">
                  <p className="text-[10px] uppercase text-stadium-muted">Dot Ball %</p>
                  <p className="font-mono font-bold text-white mt-0.5">{fmt(stats.dot_ball_pct, '%')}</p>
                </div>
                <div className="rounded-xl border border-stadium-border bg-stadium-card/50 p-2.5">
                  <p className="text-[10px] uppercase text-stadium-muted">Boundary % Runs</p>
                  <p className="font-mono font-bold text-gold-300 mt-0.5">{fmt(stats.boundary_pct, '%')}</p>
                </div>
                <div className="rounded-xl border border-stadium-border bg-stadium-card/50 p-2.5">
                  <p className="text-[10px] uppercase text-stadium-muted">Batting 1st SR / Avg</p>
                  <p className="font-mono font-bold text-white mt-0.5">
                    {fmt(stats.bat_first_sr)} / {fmt(stats.bat_first_avg)}
                  </p>
                </div>
                <div className="rounded-xl border border-stadium-border bg-stadium-card/50 p-2.5">
                  <p className="text-[10px] uppercase text-stadium-muted">Chasing SR / Avg</p>
                  <p className="font-mono font-bold text-electric-400 mt-0.5">
                    {fmt(stats.bat_chase_sr)} / {fmt(stats.bat_chase_avg)}
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-stadium-border bg-stadium-card/40">
                <table className="w-full text-left text-xs">
                  <thead className="bg-stadium-bg/80 text-[10px] uppercase tracking-wider text-stadium-muted border-b border-stadium-border">
                    <tr>
                      <th className="px-3 py-2">Phase</th>
                      <th className="px-3 py-2 text-right">Runs</th>
                      <th className="px-3 py-2 text-right">Balls</th>
                      <th className="px-3 py-2 text-right">SR</th>
                      <th className="px-3 py-2 text-right">Avg</th>
                      <th className="px-3 py-2 text-right">Boundary %</th>
                      <th className="px-3 py-2 text-right">Dot %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stadium-border/60 font-mono">
                    {[
                      { label: 'Powerplay (1-6)', p: 'bat_pp' },
                      { label: 'Middle Overs (7-15)', p: 'bat_mid' },
                      { label: 'Death Overs (16+)', p: 'bat_death' }
                    ].map(({ label, p }) => (
                      <tr key={p}>
                        <td className="px-3 py-2 font-sans font-semibold text-white">{label}</td>
                        <td className="px-3 py-2 text-right text-gold-300">{fmt(stats[`${p}_runs`])}</td>
                        <td className="px-3 py-2 text-right text-stadium-muted">{fmt(stats[`${p}_balls`])}</td>
                        <td className="px-3 py-2 text-right text-white">{fmt(stats[`${p}_sr`])}</td>
                        <td className="px-3 py-2 text-right text-stadium-muted">{fmt(stats[`${p}_avg`])}</td>
                        <td className="px-3 py-2 text-right text-stadium-muted">{fmt(stats[`${p}_boundary_pct`], '%')}</td>
                        <td className="px-3 py-2 text-right text-stadium-muted">{fmt(stats[`${p}_dot_pct`], '%')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Ball-by-ball Bowling Over-Phase & Situation Splits */}
          {stats && stats.bowling_innings > 0 && (
            <div className="space-y-2.5">
              <h4 className="font-display text-lg font-bold text-white flex items-center gap-2">
                <Activity className="w-4 h-4 text-electric-400" />
                BOWLING PHASE & SITUATION SPLITS
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div className="rounded-xl border border-stadium-border bg-stadium-card/50 p-2.5">
                  <p className="text-[10px] uppercase text-stadium-muted">Dot Ball %</p>
                  <p className="font-mono font-bold text-white mt-0.5">{fmt(stats.bowl_dot_ball_pct, '%')}</p>
                </div>
                <div className="rounded-xl border border-stadium-border bg-stadium-card/50 p-2.5">
                  <p className="text-[10px] uppercase text-stadium-muted">Boundary Conceded %</p>
                  <p className="font-mono font-bold text-gold-300 mt-0.5">{fmt(stats.boundary_conceded_pct, '%')}</p>
                </div>
                <div className="rounded-xl border border-stadium-border bg-stadium-card/50 p-2.5">
                  <p className="text-[10px] uppercase text-stadium-muted">Defending Econ / Wkts</p>
                  <p className="font-mono font-bold text-white mt-0.5">
                    {fmt(stats.bowl_first_econ)} / {fmt(stats.bowl_first_wickets)}
                  </p>
                </div>
                <div className="rounded-xl border border-stadium-border bg-stadium-card/50 p-2.5">
                  <p className="text-[10px] uppercase text-stadium-muted">Chasing Econ / Wkts</p>
                  <p className="font-mono font-bold text-electric-400 mt-0.5">
                    {fmt(stats.bowl_chase_econ)} / {fmt(stats.bowl_chase_wickets)}
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-stadium-border bg-stadium-card/40">
                <table className="w-full text-left text-xs">
                  <thead className="bg-stadium-bg/80 text-[10px] uppercase tracking-wider text-stadium-muted border-b border-stadium-border">
                    <tr>
                      <th className="px-3 py-2">Phase</th>
                      <th className="px-3 py-2 text-right">Balls</th>
                      <th className="px-3 py-2 text-right">Runs</th>
                      <th className="px-3 py-2 text-right">Wkts</th>
                      <th className="px-3 py-2 text-right">Econ</th>
                      <th className="px-3 py-2 text-right">Bowl SR</th>
                      <th className="px-3 py-2 text-right">Dot %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stadium-border/60 font-mono">
                    {[
                      { label: 'Powerplay (1-6)', p: 'bowl_pp' },
                      { label: 'Middle Overs (7-15)', p: 'bowl_mid' },
                      { label: 'Death Overs (16+)', p: 'bowl_death' }
                    ].map(({ label, p }) => (
                      <tr key={p}>
                        <td className="px-3 py-2 font-sans font-semibold text-white">{label}</td>
                        <td className="px-3 py-2 text-right text-stadium-muted">{fmt(stats[`${p}_balls`])}</td>
                        <td className="px-3 py-2 text-right text-white">{fmt(stats[`${p}_runs`])}</td>
                        <td className="px-3 py-2 text-right text-electric-400 font-bold">{fmt(stats[`${p}_wickets`])}</td>
                        <td className="px-3 py-2 text-right text-gold-300">{fmt(stats[`${p}_econ`])}</td>
                        <td className="px-3 py-2 text-right text-stadium-muted">{fmt(stats[`${p}_sr`])}</td>
                        <td className="px-3 py-2 text-right text-stadium-muted">{fmt(stats[`${p}_dot_pct`], '%')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {stats && stats.batting_innings === 0 && stats.bowling_innings === 0 && (
            <div className="rounded-xl border border-stadium-border p-4 text-xs text-stadium-muted flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-gold-400" />
              No ball-by-ball batting or bowling appearances recorded in this scope.
            </div>
          )}
        </>
      )}
    </div>
  );
}

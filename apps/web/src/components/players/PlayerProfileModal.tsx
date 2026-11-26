'use client';

import React, { useEffect, useState } from 'react';
import { CricketRole, PlayerProfileDetailDto } from '@auctioncraze/shared';
import { api } from '@/lib/api';
import { formatCricketStyle, formatLakhs } from '@/lib/formatPrice';
import { Badge } from '@/components/ui/Badge';
import { Award, Calendar, Database, Globe, Shield, Trophy, User, X } from 'lucide-react';

interface PlayerProfileModalProps {
  playerId: string | null;
  onClose: () => void;
}

const ROLE_LABELS: Record<CricketRole, string> = {
  BATSMAN: 'Batsman',
  BOWLER: 'Bowler',
  ALL_ROUNDER: 'All-Rounder',
  WICKET_KEEPER: 'Wicketkeeper'
};

function fmtStat(val: number | string | null | undefined, suffix = ''): string {
  if (val === null || val === undefined || val === '') return '—';
  return `${val}${suffix}`;
}

export function PlayerProfileModal({ playerId, onClose }: PlayerProfileModalProps) {
  const [profile, setProfile] = useState<PlayerProfileDetailDto | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    if (!playerId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [playerId, onClose]);

  useEffect(() => {
    if (!playerId) {
      setProfile(null);
      setError(null);
      setImgFailed(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setImgFailed(false);

    api
      .get(`/players/${playerId}/profile`)
      .then((res: any) => {
        if (!cancelled) {
          setProfile(res.data as PlayerProfileDetailDto);
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setError(err?.message || 'Unable to load player profile.');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [playerId]);

  if (!playerId) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={profile ? `${profile.fullName} Profile` : 'Player Profile'}
        data-testid="player-profile-modal"
        className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl bg-stadium-surface border border-gold-500/40 shadow-stage overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Close Strip */}
        <div className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-stadium-border bg-stadium-bg/70 shrink-0">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-gold-300">
            <Award className="w-4 h-4 text-gold-400" />
            <span>Verified IPL Career Dossier</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-stadium-muted hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Close player dossier"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">
          {isLoading ? (
            <div className="py-16 text-center space-y-3">
              <div className="w-9 h-9 border-2 border-gold-400 border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-sm text-stadium-muted">Loading historical IPL records...</p>
            </div>
          ) : error || !profile ? (
            <div className="py-12 text-center space-y-2">
              <p className="text-base font-semibold text-signal-unsold">{error || 'Profile unavailable'}</p>
            </div>
          ) : (
            <>
              {/* Hero Header */}
              <div className="flex flex-col sm:flex-row gap-5 items-center sm:items-start">
                <div className="w-28 h-36 rounded-2xl border border-gold-500/40 bg-stadium-card flex items-center justify-center overflow-hidden shrink-0">
                  {profile.imageUrl && !imgFailed ? (
                    <img
                      src={profile.imageUrl}
                      alt={profile.fullName}
                      onError={() => setImgFailed(true)}
                      className="w-full h-full object-cover object-top"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-1.5 text-center px-2">
                      <User className="w-8 h-8 text-gold-400" />
                      <span className="text-[10px] font-mono uppercase text-stadium-muted">No Verified Photo</span>
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0 space-y-3 text-center sm:text-left">
                  <div>
                    <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                      <Badge tone="gold">{ROLE_LABELS[profile.playingRole]}</Badge>
                      {profile.secondaryRole && (
                        <Badge tone="neutral">Secondary: {ROLE_LABELS[profile.secondaryRole]}</Badge>
                      )}
                      <Badge tone={profile.isOverseas ? 'electric' : 'sold'}>
                        <Globe className="w-3 h-3" />
                        {profile.nationality ? `${profile.nationality}${profile.isOverseas ? ' (OS)' : ''}` : 'Nationality Unknown'}
                      </Badge>
                    </div>
                    <h2
                      data-testid="profile-modal-player-name"
                      className="font-display text-3xl sm:text-4xl font-extrabold text-white tracking-wide mt-2"
                    >
                      {profile.fullName}
                    </h2>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-left">
                    <div className="rounded-xl border border-stadium-border bg-stadium-card/70 px-3 py-2">
                      <p className="text-[10px] uppercase text-stadium-muted">Batting Style</p>
                      <p className="text-xs font-semibold text-white">
                        {formatCricketStyle(profile.battingStyle)}
                      </p>
                    </div>
                    <div className="rounded-xl border border-stadium-border bg-stadium-card/70 px-3 py-2">
                      <p className="text-[10px] uppercase text-stadium-muted">Bowling Style</p>
                      <p className="text-xs font-semibold text-white">
                        {formatCricketStyle(profile.bowlingStyle)}
                      </p>
                    </div>
                    <div className="rounded-xl border border-stadium-border bg-stadium-card/70 px-3 py-2">
                      <p className="text-[10px] uppercase text-stadium-muted">IPL Span</p>
                      <p className="text-xs font-mono font-bold text-white">
                        {profile.iplDebutYear
                          ? profile.iplLastYear && profile.iplLastYear !== profile.iplDebutYear
                            ? `${profile.iplDebutYear}–${profile.iplLastYear}`
                            : `${profile.iplDebutYear}`
                          : '—'}
                      </p>
                    </div>
                    <div className="rounded-xl border border-stadium-border bg-stadium-card/70 px-3 py-2">
                      <p className="text-[10px] uppercase text-stadium-muted">Catalog Base</p>
                      <p className="text-xs font-mono font-bold text-gold-300">
                        {formatLakhs(profile.basePriceLakhs)}
                      </p>
                    </div>
                  </div>

                  {/* Franchise History */}
                  <div className="flex flex-wrap items-center justify-center sm:justify-start gap-1.5">
                    <span className="text-[11px] text-stadium-muted mr-1 flex items-center gap-1">
                      <Shield className="w-3 h-3 text-electric-400" /> Franchises:
                    </span>
                    {profile.teamHistory.length === 0 ? (
                      <span className="text-xs text-stadium-muted">None recorded</span>
                    ) : (
                      profile.teamHistory.map((team) => (
                        <span
                          key={team}
                          className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-md border border-stadium-border bg-stadium-card text-white"
                        >
                          {team}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Separated Batting / Bowling / Fielding Career Overview */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
                <div className="rounded-xl border border-stadium-border bg-stadium-card/60 p-4 space-y-2.5">
                  <div className="flex items-center justify-between border-b border-stadium-border pb-2">
                    <h3 className="font-display text-lg font-bold text-gold-300 tracking-wide">BATTING</h3>
                    <span className="text-[11px] font-mono text-stadium-muted">
                      {fmtStat(profile.careerSummary.matches)} Mats • {fmtStat(profile.careerSummary.batting.innings)} Inns
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <p className="text-stadium-muted">Runs</p>
                      <p className="font-mono font-bold text-white text-sm">{fmtStat(profile.careerSummary.batting.runs)}</p>
                    </div>
                    <div>
                      <p className="text-stadium-muted">Avg</p>
                      <p className="font-mono font-bold text-white text-sm">{fmtStat(profile.careerSummary.batting.average)}</p>
                    </div>
                    <div>
                      <p className="text-stadium-muted">SR</p>
                      <p className="font-mono font-bold text-white text-sm">{fmtStat(profile.careerSummary.batting.strikeRate)}</p>
                    </div>
                    <div>
                      <p className="text-stadium-muted">HS</p>
                      <p className="font-mono font-bold text-gold-300">{fmtStat(profile.careerSummary.batting.highestScoreText)}</p>
                    </div>
                    <div>
                      <p className="text-stadium-muted">50s</p>
                      <p className="font-mono font-bold text-white">{fmtStat(profile.careerSummary.batting.fifties)}</p>
                    </div>
                    <div>
                      <p className="text-stadium-muted">100s</p>
                      <p className="font-mono font-bold text-white">{fmtStat(profile.careerSummary.batting.hundreds)}</p>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-stadium-border bg-stadium-card/60 p-4 space-y-2.5">
                  <div className="flex items-center justify-between border-b border-stadium-border pb-2">
                    <h3 className="font-display text-lg font-bold text-electric-400 tracking-wide">BOWLING</h3>
                    <span className="text-[11px] font-mono text-stadium-muted">
                      {fmtStat(profile.careerSummary.bowling.innings)} Inns
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <p className="text-stadium-muted">Wickets</p>
                      <p className="font-mono font-bold text-white text-sm">{fmtStat(profile.careerSummary.bowling.wickets)}</p>
                    </div>
                    <div>
                      <p className="text-stadium-muted">Econ</p>
                      <p className="font-mono font-bold text-white text-sm">{fmtStat(profile.careerSummary.bowling.economy)}</p>
                    </div>
                    <div>
                      <p className="text-stadium-muted">Avg</p>
                      <p className="font-mono font-bold text-white text-sm">{fmtStat(profile.careerSummary.bowling.average)}</p>
                    </div>
                    <div>
                      <p className="text-stadium-muted">SR</p>
                      <p className="font-mono font-bold text-white">{fmtStat(profile.careerSummary.bowling.strikeRate)}</p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-stadium-muted">Best Figures</p>
                      <p className="font-mono font-bold text-electric-400">{fmtStat(profile.careerSummary.bowling.bestBowling)}</p>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-stadium-border bg-stadium-card/60 p-4 space-y-2.5">
                  <div className="flex items-center justify-between border-b border-stadium-border pb-2">
                    <h3 className="font-display text-lg font-bold text-signal-sold tracking-wide">FIELDING & RECORD</h3>
                    <Trophy className="w-4 h-4 text-signal-sold" />
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-stadium-muted">Catches</p>
                      <p className="font-mono font-bold text-white text-sm">{fmtStat(profile.careerSummary.fielding.catches)}</p>
                    </div>
                    <div>
                      <p className="text-stadium-muted">Stumpings</p>
                      <p className="font-mono font-bold text-white text-sm">{fmtStat(profile.careerSummary.fielding.stumpings)}</p>
                    </div>
                    <div>
                      <p className="text-stadium-muted">Seasons</p>
                      <p className="font-mono font-bold text-white">{profile.careerSummary.seasonsPlayed}</p>
                    </div>
                    <div>
                      <p className="text-stadium-muted">Birth Date</p>
                      <p className="font-mono text-white">{profile.dateOfBirth || 'Unknown'}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Season-wise Breakdown Table */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-xl font-bold text-white tracking-wide flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-gold-400" />
                    SEASON-BY-SEASON PERFORMANCE
                  </h3>
                  <span className="text-[11px] text-stadium-muted">
                    Missing / inapplicable figures shown as —
                  </span>
                </div>

                {profile.seasonStats.length === 0 ? (
                  <p className="text-xs text-stadium-muted py-4 text-center rounded-xl border border-stadium-border">
                    No season records available.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-stadium-border bg-stadium-card/40">
                    <table className="w-full text-left text-xs whitespace-nowrap" data-testid="season-stats-table">
                      <thead className="bg-stadium-bg/80 text-[10px] uppercase tracking-wider text-stadium-muted border-b border-stadium-border">
                        <tr>
                          <th className="px-3 py-2.5">Season</th>
                          <th className="px-3 py-2.5">Team</th>
                          <th className="px-3 py-2.5 text-right">Mat</th>
                          <th className="px-3 py-2.5 text-right">Runs</th>
                          <th className="px-3 py-2.5 text-right">HS</th>
                          <th className="px-3 py-2.5 text-right">Bat Avg</th>
                          <th className="px-3 py-2.5 text-right">SR</th>
                          <th className="px-3 py-2.5 text-right">50/100</th>
                          <th className="px-3 py-2.5 text-right">Wkts</th>
                          <th className="px-3 py-2.5 text-right">Econ</th>
                          <th className="px-3 py-2.5 text-right">Best</th>
                          <th className="px-3 py-2.5 text-right">Ct/St</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stadium-border/60 font-mono">
                        {profile.seasonStats.map((s) => (
                          <tr key={s.id} className="hover:bg-white/[0.03]">
                            <td className="px-3 py-2 font-bold text-gold-300">{s.season}</td>
                            <td className="px-3 py-2 text-white">{s.teamCode || '—'}</td>
                            <td className="px-3 py-2 text-right text-white">{fmtStat(s.matches)}</td>
                            <td className="px-3 py-2 text-right text-white font-semibold">{fmtStat(s.runs)}</td>
                            <td className="px-3 py-2 text-right text-gold-300">{fmtStat(s.highestScoreText)}</td>
                            <td className="px-3 py-2 text-right text-stadium-muted">{fmtStat(s.battingAverage)}</td>
                            <td className="px-3 py-2 text-right text-stadium-muted">{fmtStat(s.strikeRate)}</td>
                            <td className="px-3 py-2 text-right text-stadium-muted">
                              {s.fifties !== null || s.hundreds !== null
                                ? `${fmtStat(s.fifties)}/${fmtStat(s.hundreds)}`
                                : '—'}
                            </td>
                            <td className="px-3 py-2 text-right text-electric-400 font-semibold">
                              {fmtStat(s.wickets)}
                            </td>
                            <td className="px-3 py-2 text-right text-stadium-muted">{fmtStat(s.economy)}</td>
                            <td className="px-3 py-2 text-right text-stadium-muted">{fmtStat(s.bestBowling)}</td>
                            <td className="px-3 py-2 text-right text-stadium-muted">
                              {`${fmtStat(s.catches)}/${fmtStat(s.stumpings)}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Provenance Footer */}
              <div className="rounded-xl border border-stadium-border bg-stadium-bg/60 px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-stadium-muted">
                <span className="flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-electric-400" />
                  Provenance: <strong className="text-white">{profile.provenanceSource || 'Verified Open Registry'}</strong>
                </span>
                <span className="font-mono">
                  {profile.cricsheetId ? `Cricsheet: ${profile.cricsheetId}` : ''}{' '}
                  {profile.cricinfoId ? `• Cricinfo: ${profile.cricinfoId}` : ''}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

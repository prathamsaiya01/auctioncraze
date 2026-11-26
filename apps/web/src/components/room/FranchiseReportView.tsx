'use client';

import React, { useState } from 'react';
import { formatLakhs } from '@/lib/formatPrice';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { FranchiseEmblem } from '@/components/ui/FranchiseEmblem';
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Shield,
  Sparkles,
  Trophy,
  Users
} from 'lucide-react';

interface FranchiseReportViewProps {
  report: any;
  onInspectPlayer?: (playerId: string) => void;
}

function fmtNum(val: number | null | undefined, digits = 1): string {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return '—';
  return Number(val).toFixed(digits);
}

export function FranchiseReportView({ report, onInspectPlayer }: FranchiseReportViewProps) {
  const [showMethodology, setShowMethodology] = useState(false);

  if (!report) return null;

  const ratings = report.team_ratings || {};
  const osComp = report.overseas_composition || {};
  const xi = report.playing_xi_prediction || {};
  const explanations: Record<string, string> = report.score_explanations || {};

  const sufficiencyTone =
    report.sufficiency_status === 'SUFFICIENT'
      ? 'sold'
      : report.sufficiency_status === 'INCOMPLETE_SQUAD'
      ? 'gold'
      : 'unsold';

  const metrics = [
    { key: 'overall_rating', label: 'Overall Rating', val: ratings.overall_rating, cls: 'border-gold-500/40 text-gold-300' },
    { key: 'batting_strength', label: 'Batting Strength', val: ratings.batting_strength, cls: 'border-signal-sold/35 text-signal-sold' },
    { key: 'bowling_strength', label: 'Bowling Strength', val: ratings.bowling_strength, cls: 'border-electric-400/35 text-electric-400' },
    { key: 'all_rounder_strength', label: 'All-Rounder Strength', val: ratings.all_rounder_strength, cls: 'border-stadium-border text-white' },
    { key: 'squad_depth', label: 'Squad Depth', val: ratings.squad_depth, cls: 'border-stadium-border text-white' },
    { key: 'pace_coverage', label: 'Pace Coverage', val: ratings.pace_coverage, cls: 'border-stadium-border text-white' },
    { key: 'spin_coverage', label: 'Spin Coverage', val: ratings.spin_coverage, cls: 'border-stadium-border text-white' },
    { key: 'wicketkeeper_coverage', label: 'WK Coverage', val: ratings.wicketkeeper_coverage, cls: 'border-stadium-border text-white' },
    { key: 'role_balance', label: 'Role Balance', val: ratings.role_balance, cls: 'border-stadium-border text-white' }
  ];

  return (
    <div className="space-y-5" data-testid={`franchise-report-${report.franchiseCode}`}>
      {/* Franchise Identity Header */}
      <Card highlight="gold" className="p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <FranchiseEmblem
              code={report.franchiseCode}
              primaryColor={report.primaryColor || '#D4AF37'}
              secondaryColor={report.secondaryColor || '#1E293B'}
              size="lg"
            />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-3xl font-extrabold text-white tracking-wide">
                  {report.franchiseDisplayName || report.franchiseName} ({report.franchiseCode})
                </h2>
                {report.rank ? (
                  <Badge tone="gold">Rank #{report.rank}</Badge>
                ) : (
                  <Badge tone="unsold">Unranked ({report.sufficiency_status})</Badge>
                )}
                <Badge tone={sufficiencyTone}>{report.sufficiency_status}</Badge>
                <Badge tone="neutral">Confidence: {report.data_confidence}</Badge>
              </div>
              <p className="text-xs text-stadium-muted mt-1">
                Owner: <strong className="text-white">{report.ownerDisplayName || 'Unclaimed'}</strong> •{' '}
                Actual Squad: <strong className="font-mono text-white">{report.squad_size}</strong>/{report.max_squad_size} (Min {report.min_squad_size}) •{' '}
                Spent: <strong className="font-mono text-gold-300">{formatLakhs(report.spentLakhs || 0)}</strong> •{' '}
                Remaining: <strong className="font-mono text-white">{formatLakhs(report.remainingPurseLakhs || 0)}</strong>
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-gold-500/40 bg-stadium-bg/75 px-5 py-3 text-center shrink-0">
            <p className="text-[10px] uppercase tracking-wider text-stadium-muted font-semibold">
              Overall Statistical Rating
            </p>
            <p className="font-mono text-3xl font-extrabold text-gold-300 mt-0.5">
              {ratings.overall_rating !== null && ratings.overall_rating !== undefined
                ? `${fmtNum(ratings.overall_rating)}`
                : 'N/A'}
            </p>
            <p className="text-[10px] text-stadium-muted font-mono">
              {ratings.overall_rating !== null && ratings.overall_rating !== undefined ? 'out of 100 (Non-Official)' : 'Insufficient Data'}
            </p>
          </div>
        </div>

        {/* Sample-Size & Incomplete Squad Warnings */}
        {report.sample_size_warnings?.length > 0 && (
          <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-1">
            <p className="font-bold flex items-center gap-1.5 text-amber-300">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Data Confidence & Squad Coverage Disclosures
            </p>
            <ul className="list-disc list-inside space-y-0.5 text-amber-100/90">
              {report.sample_size_warnings.map((w: string) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Core 9 Numerical Metrics + Overseas Composition Card */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
          {metrics.map((m) => (
            <div key={m.key} className={`rounded-xl border bg-stadium-card/75 px-3 py-2.5 ${m.cls}`}>
              <p className="text-[10px] uppercase tracking-wider text-stadium-muted">{m.label}</p>
              <p className="font-mono text-xl font-extrabold mt-0.5">{fmtNum(m.val)}</p>
            </div>
          ))}
          <div
            className={`rounded-xl border bg-stadium-card/75 px-3 py-2.5 ${
              osComp.compliant ? 'border-signal-sold/35 text-signal-sold' : 'border-signal-unsold/45 text-signal-unsold'
            }`}
          >
            <p className="text-[10px] uppercase tracking-wider text-stadium-muted">Overseas Slots</p>
            <p className="font-mono text-xl font-extrabold mt-0.5">
              {osComp.overseas_count ?? 0}/{osComp.max_overseas ?? 8}
            </p>
            <p className="text-[10px] font-mono text-stadium-muted">
              {osComp.domestic_count ?? 0} Dom • {osComp.compliant ? 'OK' : 'Exceeds'}
            </p>
          </div>
        </div>

        {/* Formula Explanations Toggle */}
        <div>
          <button
            type="button"
            onClick={() => setShowMethodology((v) => !v)}
            data-testid="toggle-methodology-btn"
            className="text-xs font-semibold text-electric-400 hover:text-electric-300 inline-flex items-center gap-1.5"
          >
            <HelpCircle className="w-3.5 h-3.5" />
            {showMethodology ? 'Hide Rating Formula Explanations' : 'How Each Score Is Calculated'}
            {showMethodology ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          {showMethodology && (
            <div
              className="mt-2.5 rounded-xl border border-stadium-border bg-stadium-bg/75 p-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs"
              data-testid="methodology-panel"
            >
              {Object.entries(explanations).map(([k, text]) => (
                <div key={k} className="space-y-0.5">
                  <p className="font-mono font-bold text-gold-300 uppercase text-[11px]">{k.replace(/_/g, ' ')}</p>
                  <p className="text-stadium-muted leading-relaxed">{text}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Best Batters / Bowlers / All-Rounders */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { title: 'Best-Rated Batters', list: report.best_batters || [], field: 'batting_rating', tone: 'text-signal-sold' },
          { title: 'Best-Rated Bowlers', list: report.best_bowlers || [], field: 'bowling_rating', tone: 'text-electric-400' },
          { title: 'Best-Rated All-Rounders', list: report.best_all_rounders || [], field: 'all_rounder_rating', tone: 'text-gold-300' }
        ].map((grp) => (
          <Card key={grp.title} className="p-4 space-y-2.5">
            <h3 className="font-display text-lg font-bold text-white tracking-wide flex items-center gap-2 border-b border-stadium-border pb-2">
              <Award className="w-4 h-4 text-gold-400" />
              {grp.title.toUpperCase()}
            </h3>
            {grp.list.length === 0 ? (
              <p className="text-xs text-stadium-muted py-2">No qualified players with sufficient IPL sample.</p>
            ) : (
              <div className="space-y-2">
                {grp.list.map((p: any, idx: number) => (
                  <div
                    key={p.player_id}
                    className="rounded-lg border border-stadium-border/70 bg-stadium-card/60 px-3 py-2 flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-white truncate">
                        {idx + 1}. {p.full_name}
                      </p>
                      <p className="text-[10px] text-stadium-muted">
                        {p.playing_role} • {p.sample_matches}m {p.is_overseas ? '• OS' : ''}
                      </p>
                    </div>
                    <span className={`font-mono font-bold text-sm shrink-0 ${grp.tone}`}>
                      {fmtNum(p[grp.field] ?? p.overall_rating)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>

      {/* Strengths & Weaknesses */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-4 space-y-2 border-signal-sold/30">
          <h3 className="font-display text-lg font-bold text-signal-sold flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4" /> STATISTICAL STRENGTHS
          </h3>
          {report.strengths?.length > 0 ? (
            <ul className="text-xs text-white/90 space-y-1 list-disc list-inside">
              {report.strengths.map((s: string) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-stadium-muted">No dominant structural strengths identified in current roster.</p>
          )}
        </Card>

        <Card className="p-4 space-y-2 border-amber-500/30">
          <h3 className="font-display text-lg font-bold text-amber-300 flex items-center gap-1.5">
            <Shield className="w-4 h-4" /> STATISTICAL WEAKNESSES & GAPS
          </h3>
          {report.weaknesses?.length > 0 ? (
            <ul className="text-xs text-stadium-muted space-y-1 list-disc list-inside">
              {report.weaknesses.map((w: string) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-stadium-muted">No major structural gaps flagged across core T20 roles.</p>
          )}
        </Card>
      </div>

      {/* Predicted Playing XI & Impact Player */}
      <Card highlight="electric" className="p-5 space-y-4" data-testid="post-auction-playing-xi-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stadium-border pb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-electric-400" />
            <h3 className="font-display text-xl font-bold text-white tracking-wide">
              PREDICTED PLAYING XI & IMPACT PLAYER
            </h3>
          </div>
          <Badge tone="electric">SIMULATION PREDICTION — NOT OFFICIAL LINEUP</Badge>
        </div>

        {!xi.available ? (
          <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 text-xs text-amber-200">
            {xi.reason || 'Minimum 11 players (with >=7 domestic players) required to generate a legal Playing XI prediction.'}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge tone="gold">
                <Trophy className="w-3 h-3" /> Captain Candidate: {xi.captain_name}
              </Badge>
              <Badge tone="electric">Vice-Captain: {xi.vice_captain_name}</Badge>
              <Badge tone={xi.overseas_count_in_xi <= 4 ? 'sold' : 'unsold'}>
                Overseas in XI: {xi.overseas_count_in_xi}/4
              </Badge>
              <Badge tone="neutral">{xi.rule_version}</Badge>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {(xi.playing_xi_details || []).map((p: any) => {
                const isC = p.player_id === xi.captain_candidate;
                const isVc = p.player_id === xi.vice_captain_candidate;
                return (
                  <div
                    key={p.player_id}
                    className="rounded-xl border border-stadium-border bg-stadium-card/65 px-3 py-2 flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono font-bold text-gold-300 w-5">{p.slot}.</span>
                      <span className="font-semibold text-white truncate">
                        {p.full_name} {isC ? '(C)' : isVc ? '(VC)' : ''}
                      </span>
                      {p.is_overseas && <Badge tone="electric">OS</Badge>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-stadium-muted">{p.playing_role}</span>
                      <span className="font-mono font-bold text-gold-300">{fmtNum(p.overall_rating)}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {xi.impact_player_details && (
              <div className="rounded-xl border border-gold-500/40 bg-gold-500/10 px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Users className="w-4 h-4 text-gold-400" />
                  <div>
                    <p className="text-[10px] uppercase tracking-wider font-bold text-gold-300">
                      Predicted 12th Impact Player (Simulation)
                    </p>
                    <p className="text-sm font-semibold text-white">
                      {xi.impact_player_details.full_name}{' '}
                      <span className="text-xs text-stadium-muted">
                        ({xi.impact_player_details.playing_role} •{' '}
                        {xi.impact_player_details.is_overseas ? 'Overseas' : 'Domestic'})
                      </span>
                    </p>
                  </div>
                </div>
                <span className="font-mono font-bold text-gold-300 text-sm">
                  {fmtNum(xi.impact_player_details.overall_rating)}
                </span>
              </div>
            )}

            {xi.explanation?.length > 0 && (
              <ul className="text-[11px] text-stadium-muted space-y-1 list-disc list-inside">
                {xi.explanation.map((line: string) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      {/* Finalized Auction Roster Snapshot */}
      {report.roster?.length > 0 && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between border-b border-stadium-border pb-2">
            <h3 className="font-display text-lg font-bold text-white tracking-wide">
              FINALIZED AUCTION SQUAD ({report.roster.length})
            </h3>
            <span className="text-[11px] text-stadium-muted">Includes retained & finalized SOLD purchases only</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {report.roster.map((m: any) => (
              <button
                key={`${m.playerId}-${m.acquisitionType}`}
                type="button"
                onClick={() => onInspectPlayer?.(m.playerId)}
                className="text-left rounded-xl border border-stadium-border bg-stadium-card/55 hover:border-gold-500/45 px-3 py-2 flex items-center justify-between gap-2 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white truncate">
                    {m.fullName} {m.isOverseas ? ' (OS)' : ''}
                  </p>
                  <p className="text-[10px] text-stadium-muted">
                    {m.playingRole} • {m.acquisitionType}
                  </p>
                </div>
                <span className="font-mono text-xs font-bold text-gold-300 shrink-0">
                  {formatLakhs(m.priceLakhs)}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

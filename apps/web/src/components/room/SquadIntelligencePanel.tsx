'use client';

import React, { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { AlertTriangle, CheckCircle2, Shield, Sparkles, Trophy, Users } from 'lucide-react';

interface SquadIntelligencePanelProps {
  roomCode: string;
  franchiseId: string;
  mode: 'STRENGTH' | 'PLAYING_XI';
  onInspectPlayer?: (playerId: string) => void;
}

export function SquadIntelligencePanel({
  roomCode,
  franchiseId,
  mode
}: SquadIntelligencePanelProps) {
  const [pitchType, setPitchType] = useState<'BALANCED' | 'BATTING' | 'PACE' | 'SPIN'>('BALANCED');
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMlDisabled, setIsMlDisabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setIsMlDisabled(false);

    const req =
      mode === 'STRENGTH'
        ? api.get(`/intelligence/rooms/${roomCode}/franchises/${franchiseId}/team-strength`)
        : api.post(`/intelligence/rooms/${roomCode}/franchises/${franchiseId}/playing-xi`, {
            pitch_type: pitchType
          });

    req
      .then((res: any) => {
        if (!cancelled) setData(res.data);
      })
      .catch((err: any) => {
        if (!cancelled) {
          setIsMlDisabled(err?.code === 'ML_SERVICE_DISABLED');
          setError(err?.message || 'Unable to compute squad intelligence.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [roomCode, franchiseId, mode, pitchType]);

  if (loading) {
    return (
      <div className="py-10 text-center space-y-2">
        <div className="w-7 h-7 border-2 border-gold-400 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-xs text-stadium-muted">
          {mode === 'STRENGTH' ? 'Auditing squad balance & depth...' : 'Optimizing IPL Playing XI & Impact Player...'}
        </p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 text-xs text-amber-200 flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
        <div>
          <p className="font-semibold">
            {isMlDisabled
              ? 'ML Intelligence Disabled in Zero-Cost Mode'
              : mode === 'PLAYING_XI'
              ? 'Playing XI Not Yet Formable'
              : 'Team Strength Unavailable'}
          </p>
          <p className="text-amber-200/80 mt-0.5">{error || 'Insufficient squad data.'}</p>
        </div>
      </div>
    );
  }

  if (mode === 'STRENGTH') {
    const comp = data.composition || {};
    return (
      <div className="space-y-4" data-testid="squad-strength-panel">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
          {[
            { label: 'Overall Strength', val: data.overall_strength, cls: 'text-gold-300 border-gold-500/35' },
            { label: 'Batting Depth', val: data.batting_depth, cls: 'text-signal-sold border-signal-sold/30' },
            { label: 'Bowling Depth', val: data.bowling_depth, cls: 'text-electric-400 border-electric-500/30' },
            { label: 'Pace/Spin Balance', val: data.pace_spin_balance, cls: 'text-white border-stadium-border' },
            { label: 'All-Rounder Idx', val: data.all_rounder_index, cls: 'text-white border-stadium-border' }
          ].map((m) => (
            <div key={m.label} className={`rounded-xl border bg-stadium-card/70 px-3 py-2 text-center ${m.cls}`}>
              <p className="text-[10px] uppercase text-stadium-muted">{m.label}</p>
              <p className="font-mono text-lg font-extrabold mt-0.5">{Number(m.val || 0).toFixed(1)}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={data.overseas_compliance ? 'sold' : 'unsold'}>
            {data.overseas_compliance ? 'Overseas Limit OK' : 'Overseas Limit Exceeded'} ({data.overseas_count})
          </Badge>
          <Badge tone="neutral">Squad Size: {data.squad_size}</Badge>
          <Badge tone="neutral">WK: {comp.WICKET_KEEPER || 0}</Badge>
          <Badge tone="neutral">Pace: {comp.pace_bowlers || 0}</Badge>
          <Badge tone="neutral">Spin: {comp.spin_bowlers || 0}</Badge>
          <Badge tone="neutral">
            LHB/RHB: {comp.left_hand_batters || 0}/{comp.right_hand_batters || 0}
          </Badge>
        </div>

        {data.strengths?.length > 0 && (
          <div className="rounded-xl border border-signal-sold/30 bg-signal-sold/5 p-3 space-y-1.5">
            <p className="text-xs font-bold text-signal-sold flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" /> Structural Strengths
            </p>
            <ul className="text-xs text-white/90 space-y-1 list-disc list-inside">
              {data.strengths.map((s: string) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        )}

        {data.gaps?.length > 0 && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-1.5">
            <p className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" /> Analytical Composition Gaps
            </p>
            <ul className="text-xs text-stadium-muted space-y-1 list-disc list-inside">
              {data.gaps.map((g: string) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-[11px] text-stadium-muted bg-stadium-bg/60 border border-stadium-border/70 rounded-lg px-3 py-2">
          {data.disclaimer}
        </p>
      </div>
    );
  }

  // mode === 'PLAYING_XI'
  return (
    <div className="space-y-4" data-testid="squad-playing-xi-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-gold-400" />
          <span className="text-xs font-bold uppercase tracking-wider text-gold-300">
            {data.prediction_label}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-stadium-muted">Pitch Context:</span>
          {(['BALANCED', 'BATTING', 'PACE', 'SPIN'] as const).map((pt) => (
            <button
              key={pt}
              type="button"
              onClick={() => setPitchType(pt)}
              className={`px-2 py-1 rounded text-[10px] font-mono font-semibold ${
                pitchType === pt
                  ? 'bg-electric-500 text-white'
                  : 'bg-stadium-card text-stadium-muted border border-stadium-border hover:text-white'
              }`}
            >
              {pt}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone="gold">
          <Trophy className="w-3 h-3" /> C: {data.captain_name}
        </Badge>
        <Badge tone="electric">VC: {data.vice_captain_name}</Badge>
        <Badge tone={data.overseas_count_in_xi <= 4 ? 'sold' : 'unsold'}>
          Overseas in XI: {data.overseas_count_in_xi}/4
        </Badge>
        <Badge tone="neutral">{data.rule_version}</Badge>
      </div>

      <div className="rounded-xl border border-stadium-border bg-stadium-card/50 divide-y divide-stadium-border/60">
        {(data.playing_xi_details || []).map((p: any) => {
          const isCap = p.player_id === data.captain_candidate;
          const isVc = p.player_id === data.vice_captain_candidate;
          return (
            <div key={p.player_id} className="px-3 py-2 flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-5 text-center font-mono text-[11px] text-gold-300 font-bold">
                  {p.slot}.
                </span>
                <span className="font-semibold text-white truncate">
                  {p.full_name} {isCap ? '(C)' : isVc ? '(VC)' : ''}
                </span>
                {p.is_overseas && <Badge tone="electric">OS</Badge>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-stadium-muted">{p.playing_role}</span>
                <span className="font-mono font-bold text-gold-300">{p.overall_rating}</span>
              </div>
            </div>
          );
        })}
      </div>

      {data.impact_player_details && (
        <div className="rounded-xl border border-gold-500/40 bg-gold-500/10 px-3.5 py-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-gold-400" />
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gold-300 font-bold">
                Predicted 12th Impact Player
              </p>
              <p className="text-sm font-semibold text-white">
                {data.impact_player_details.full_name}{' '}
                <span className="text-xs text-stadium-muted">
                  ({data.impact_player_details.playing_role}
                  {data.impact_player_details.is_overseas ? ' • OS' : ' • Domestic'})
                </span>
              </p>
            </div>
          </div>
          <span className="font-mono font-bold text-gold-300 text-sm">
            {data.impact_player_details.overall_rating}
          </span>
        </div>
      )}

      {data.explanation?.length > 0 && (
        <ul className="text-[11px] text-stadium-muted space-y-1 list-disc list-inside">
          {data.explanation.map((line: string) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      <p className="text-[11px] text-stadium-muted bg-stadium-bg/60 border border-stadium-border/70 rounded-lg px-3 py-2">
        {data.disclaimer}
      </p>
    </div>
  );
}

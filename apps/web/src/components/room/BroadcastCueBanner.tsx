'use client';

import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Clock, Gavel, PauseCircle, PlayCircle, Sparkles } from 'lucide-react';
import { FranchiseEmblem } from '@/components/ui/FranchiseEmblem';
import { formatLakhs } from '@/lib/formatPrice';

export interface BroadcastCue {
  id: string;
  kind: 'BID' | 'EXTENDED' | 'PAUSED' | 'RESUMED' | 'NEW_LOT';
  franchiseCode?: string;
  franchiseDisplayName?: string;
  franchiseColor?: string;
  amountLakhs?: number;
  previousBidLakhs?: number;
  playerName?: string;
  subtitle?: string;
}

interface BroadcastCueBannerProps {
  cue: BroadcastCue | null;
  reducedMotion: boolean;
}

export const BroadcastCueBanner = React.memo(function BroadcastCueBanner({
  cue,
  reducedMotion
}: BroadcastCueBannerProps) {
  return (
    <div className="min-h-[46px] pointer-events-none" aria-live="polite" data-testid="broadcast-cue-region">
      <AnimatePresence mode="wait">
        {cue && (
          <motion.div
            key={cue.id}
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: reducedMotion ? 0.05 : 0.22, ease: 'easeOut' }}
            data-testid={`broadcast-cue-${cue.kind.toLowerCase()}`}
            className="rounded-xl border px-3.5 py-2 flex items-center justify-between gap-3 backdrop-blur-md"
            style={{
              borderColor:
                cue.kind === 'BID'
                  ? `${cue.franchiseColor || '#D4AF37'}70`
                  : cue.kind === 'EXTENDED'
                  ? 'rgba(56, 189, 248, 0.55)'
                  : cue.kind === 'PAUSED'
                  ? 'rgba(245, 158, 11, 0.55)'
                  : cue.kind === 'RESUMED'
                  ? 'rgba(16, 185, 129, 0.55)'
                  : 'rgba(212, 175, 55, 0.45)',
              background:
                cue.kind === 'BID'
                  ? 'linear-gradient(90deg, rgba(212,175,55,0.14), rgba(14,22,40,0.92))'
                  : 'rgba(14, 22, 40, 0.92)'
            }}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {cue.kind === 'BID' && cue.franchiseCode ? (
                <FranchiseEmblem
                  code={cue.franchiseCode}
                  primaryColor={cue.franchiseColor || '#D4AF37'}
                  secondaryColor="#0C1322"
                  size="sm"
                />
              ) : cue.kind === 'EXTENDED' ? (
                <Clock className="w-4 h-4 text-electric-400 shrink-0" />
              ) : cue.kind === 'PAUSED' ? (
                <PauseCircle className="w-4 h-4 text-signal-warn shrink-0" />
              ) : cue.kind === 'RESUMED' ? (
                <PlayCircle className="w-4 h-4 text-signal-sold shrink-0" />
              ) : (
                <Sparkles className="w-4 h-4 text-gold-400 shrink-0" />
              )}

              <div className="min-w-0">
                <p className="text-xs sm:text-sm font-bold text-white truncate">
                  {cue.kind === 'BID' && `${cue.franchiseDisplayName || cue.franchiseCode} LEADS THE BID`}
                  {cue.kind === 'EXTENDED' && 'TIMER EXTENDED — FINAL SECONDS RESET'}
                  {cue.kind === 'PAUSED' && 'AUCTION FLOOR PAUSED BY HOST'}
                  {cue.kind === 'RESUMED' && 'AUCTION FLOOR RESUMED — BIDDING OPEN'}
                  {cue.kind === 'NEW_LOT' && `ON STAGE: ${cue.playerName}`}
                </p>
                {cue.subtitle && (
                  <p className="text-[11px] text-stadium-muted truncate">{cue.subtitle}</p>
                )}
              </div>
            </div>

            {cue.kind === 'BID' && typeof cue.amountLakhs === 'number' && (
              <div className="flex items-center gap-1.5 font-mono text-xs sm:text-sm shrink-0">
                {typeof cue.previousBidLakhs === 'number' && cue.previousBidLakhs < cue.amountLakhs && (
                  <>
                    <span className="text-stadium-muted line-through">
                      {formatLakhs(cue.previousBidLakhs)}
                    </span>
                    <span className="text-stadium-muted">→</span>
                  </>
                )}
                <span className="font-extrabold text-gold-300 flex items-center gap-1">
                  <Gavel className="w-3.5 h-3.5" />
                  {formatLakhs(cue.amountLakhs)}
                </span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

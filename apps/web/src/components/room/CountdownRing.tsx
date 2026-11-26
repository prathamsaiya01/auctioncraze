'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AuctionStage } from '@auctioncraze/shared';
import { playCountdownTick } from '@/lib/audioEffects';

interface CountdownRingProps {
  deadlineMs: number | null;
  remainingSeconds: number;
  countdownSeconds: number;
  isPaused: boolean;
  auctionStage: AuctionStage;
  clockOffsetRef: React.MutableRefObject<number>;
  soundPrefsRef: React.MutableRefObject<{ isMuted: boolean; volume: number }>;
  prefersReducedMotion: boolean | null;
}

export const CountdownRing = React.memo(function CountdownRing({
  deadlineMs,
  remainingSeconds,
  countdownSeconds,
  isPaused,
  auctionStage,
  clockOffsetRef,
  soundPrefsRef,
  prefersReducedMotion
}: CountdownRingProps) {
  const [liveSec, setLiveSec] = useState<number>(remainingSeconds);
  const lastTickSecRef = useRef<number | null>(null);

  useEffect(() => {
    const compute = () => {
      if (isPaused || auctionStage === 'PAUSED') {
        setLiveSec(remainingSeconds);
        return;
      }
      if (
        auctionStage === 'BIDDING_CLOSED' ||
        auctionStage === 'PLAYER_SOLD' ||
        auctionStage === 'PLAYER_UNSOLD' ||
        auctionStage === 'COMPLETED'
      ) {
        setLiveSec(0);
        return;
      }
      if (deadlineMs) {
        const estimatedServerNow = Date.now() + clockOffsetRef.current;
        const diffSec = Math.max(0, (deadlineMs - estimatedServerNow) / 1000);
        setLiveSec(diffSec);
        const ceilSec = Math.ceil(diffSec);
        if (ceilSec >= 1 && ceilSec <= 3 && lastTickSecRef.current !== ceilSec) {
          lastTickSecRef.current = ceilSec;
          playCountdownTick(soundPrefsRef.current.isMuted, soundPrefsRef.current.volume);
        } else if (ceilSec > 3 || ceilSec <= 0) {
          lastTickSecRef.current = null;
        }
      } else {
        setLiveSec(remainingSeconds);
      }
    };

    compute();
    const interval = setInterval(compute, 100);
    return () => clearInterval(interval);
  }, [deadlineMs, remainingSeconds, isPaused, auctionStage, clockOffsetRef, soundPrefsRef]);

  const maxTimerSec = Math.max(1, countdownSeconds);
  const progressRatio = Math.max(0, Math.min(1, liveSec / maxTimerSec));
  const isUrgent = liveSec > 0 && liveSec <= 5 && auctionStage === 'LIVE' && !isPaused;
  const ringCircumference = 2 * Math.PI * 38;
  const ringOffset = ringCircumference * (1 - progressRatio);

  return (
    <div className="flex items-center gap-3" data-testid="auction-timer">
      <div
        className={`relative w-20 h-20 flex items-center justify-center ${
          isUrgent && !prefersReducedMotion ? 'animate-pulse' : ''
        }`}
      >
        <svg className="w-20 h-20 -rotate-90" viewBox="0 0 88 88">
          <circle
            cx="44"
            cy="44"
            r="38"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="6"
            fill="transparent"
          />
          <circle
            cx="44"
            cy="44"
            r="38"
            stroke={
              auctionStage === 'BIDDING_CLOSED'
                ? '#F59E0B'
                : isUrgent
                ? '#EF4444'
                : '#D4AF37'
            }
            strokeWidth="6"
            strokeLinecap="round"
            fill="transparent"
            strokeDasharray={ringCircumference}
            strokeDashoffset={ringOffset}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={`font-mono text-xl font-bold leading-none ${
              auctionStage === 'BIDDING_CLOSED'
                ? 'text-signal-warn text-xs'
                : isUrgent
                ? 'text-signal-unsold'
                : 'text-white'
            }`}
          >
            {auctionStage === 'BIDDING_CLOSED' ? 'CLOSED' : `${Math.ceil(liveSec)}s`}
          </span>
          <span className="text-[9px] uppercase tracking-wider text-stadium-muted mt-0.5">
            {isPaused ? 'Paused' : 'Clock'}
          </span>
        </div>
      </div>
    </div>
  );
});

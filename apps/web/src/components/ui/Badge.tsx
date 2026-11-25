import React from 'react';
import { clsx } from 'clsx';

type BadgeTone = 'gold' | 'electric' | 'sold' | 'unsold' | 'neutral';

const TONE_MAP: Record<BadgeTone, string> = {
  gold: 'bg-gold-500/15 text-gold-300 border-gold-500/35',
  electric: 'bg-electric-500/15 text-electric-400 border-electric-400/35',
  sold: 'bg-signal-sold/15 text-signal-sold border-signal-sold/35',
  unsold: 'bg-signal-unsold/15 text-signal-unsold border-signal-unsold/35',
  neutral: 'bg-white/5 text-stadium-muted border-stadium-border'
};

export function Badge({
  tone = 'neutral',
  className,
  children
}: {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider',
        TONE_MAP[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

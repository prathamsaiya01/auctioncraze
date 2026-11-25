import React from 'react';
import { clsx } from 'clsx';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  highlight?: 'none' | 'gold' | 'electric';
}

export function Card({ highlight = 'none', className, children, ...props }: CardProps) {
  return (
    <div
      className={clsx(
        'rounded-2xl bg-stadium-surface/90 backdrop-blur-md border transition-colors',
        highlight === 'gold' && 'border-gold-500/45 shadow-gold-glow',
        highlight === 'electric' && 'border-electric-400/40 shadow-electric-glow',
        highlight === 'none' && 'border-stadium-border shadow-stage',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

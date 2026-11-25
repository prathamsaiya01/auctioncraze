'use client';

import React from 'react';
import { clsx } from 'clsx';

type ButtonVariant = 'gold' | 'electric' | 'surface' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  gold: 'bg-gradient-to-b from-gold-400 to-gold-500 text-stadium-canvas font-bold shadow-gold-glow hover:from-gold-300 hover:to-gold-400 active:scale-[0.98]',
  electric:
    'bg-electric-500/20 text-electric-400 border border-electric-400/40 hover:bg-electric-500/30 shadow-electric-glow active:scale-[0.98]',
  surface:
    'bg-stadium-elevated text-stadium-text border border-stadium-border hover:border-gold-500/40 hover:bg-stadium-elevated/80',
  ghost: 'bg-transparent text-stadium-muted hover:text-stadium-text hover:bg-white/5',
  danger: 'bg-signal-unsold/15 text-signal-unsold border border-signal-unsold/35 hover:bg-signal-unsold/25'
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs rounded-lg gap-1.5',
  md: 'px-4 py-2.5 text-sm rounded-xl gap-2',
  lg: 'px-6 py-3.5 text-base rounded-xl gap-2.5'
};

export function Button({
  variant = 'gold',
  size = 'md',
  isLoading = false,
  leftIcon,
  className,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled || isLoading}
      className={clsx(
        'inline-flex items-center justify-center font-semibold tracking-wide transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-gold-400/60 disabled:opacity-50 disabled:pointer-events-none',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className
      )}
      {...props}
    >
      {isLoading ? (
        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : (
        leftIcon
      )}
      <span>{children}</span>
    </button>
  );
}

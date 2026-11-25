import React from 'react';
import { clsx } from 'clsx';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export function Input({ label, hint, error, className, id, ...props }: InputProps) {
  const generatedId = React.useId();
  const inputId = id || props.name || generatedId;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={clsx(
          'w-full rounded-xl bg-stadium-card/90 border px-3.5 py-2.5 text-sm text-stadium-text placeholder:text-stadium-muted/50 transition-colors focus:outline-none focus:ring-2',
          error
            ? 'border-signal-unsold/70 focus:ring-signal-unsold/30'
            : 'border-stadium-border focus:border-gold-500/60 focus:ring-gold-500/20',
          className
        )}
        {...props}
      />
      {error ? (
        <p className="text-xs text-signal-unsold">{error}</p>
      ) : hint ? (
        <p className="text-xs text-stadium-muted/80">{hint}</p>
      ) : null}
    </div>
  );
}

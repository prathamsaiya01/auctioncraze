import React from 'react';
import { clsx } from 'clsx';

export function FranchiseEmblem({
  code,
  primaryColor,
  secondaryColor,
  size = 'md'
}: {
  code: string;
  primaryColor: string;
  secondaryColor: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizeClass =
    size === 'sm' ? 'w-8 h-8 text-xs' : size === 'lg' ? 'w-12 h-12 text-base' : 'w-10 h-10 text-sm';

  return (
    <div
      className={clsx(
        'rounded-xl flex items-center justify-center font-display font-extrabold tracking-wider shadow-md shrink-0 border',
        sizeClass
      )}
      style={{
        background: `linear-gradient(135deg, ${primaryColor} 0%, ${secondaryColor} 100%)`,
        borderColor: 'rgba(255,255,255,0.22)',
        color: '#FFFFFF',
        textShadow: '0 1px 2px rgba(0,0,0,0.65)'
      }}
    >
      {code}
    </div>
  );
}

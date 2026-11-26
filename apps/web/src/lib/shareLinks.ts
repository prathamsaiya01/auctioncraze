'use client';

import { RoomVisibility } from '@auctioncraze/shared';

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1';
}

/**
 * Resolves the canonical public origin for shareable invite links without ever
 * hardcoding localhost. In deployed environments, non-loopback `window.location.origin`
 * or `NEXT_PUBLIC_APP_URL` is used directly; local dev resolves dynamically from runtime origin.
 */
export function getShareBaseUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  let configuredNonLocal = '';
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (!isLoopbackHost(parsed.hostname)) {
        configuredNonLocal = parsed.origin;
      }
    } catch {
      // Ignore malformed env value cleanly
    }
  }

  if (typeof window !== 'undefined') {
    const runtimeOrigin = window.location.origin.replace(/\/+$/, '');
    if (!isLoopbackHost(window.location.hostname)) {
      return runtimeOrigin;
    }
    return configuredNonLocal || runtimeOrigin;
  }

  return configuredNonLocal || configured;
}

export interface BuildRoomInviteOptions {
  roomCode: string;
  visibility?: RoomVisibility | string;
  inviteToken?: string | null;
  spectatorInviteToken?: string | null;
  roleLock?: 'owner_or_spectator' | 'spectator';
  seasonCode?: string | null;
}

export function buildRoomInviteUrl(opts: BuildRoomInviteOptions): string {
  const baseUrl = getShareBaseUrl();
  const normalizedCode = opts.roomCode.trim().toUpperCase();
  const params = new URLSearchParams();

  if (opts.roleLock === 'spectator') {
    if (opts.spectatorInviteToken) {
      params.set('invite', opts.spectatorInviteToken);
    }
    params.set('role', 'spectator');
  } else if (opts.visibility === RoomVisibility.PRIVATE && opts.inviteToken) {
    params.set('invite', opts.inviteToken);
  }

  if (opts.seasonCode) {
    params.set('season', opts.seasonCode.trim().toUpperCase());
  }

  const qs = params.toString();
  const path = `/room/${encodeURIComponent(normalizedCode)}${qs ? `?${qs}` : ''}`;
  return baseUrl ? `${baseUrl}${path}` : path;
}

export function buildSeasonInviteUrl(seasonCode: string): string {
  const baseUrl = getShareBaseUrl();
  const path = `/seasons/${encodeURIComponent(seasonCode.trim().toUpperCase())}`;
  return baseUrl ? `${baseUrl}${path}` : path;
}

/**
 * Extracts a safe relative route target whether the user pastes a raw room code
 * (e.g. `AC-7X9K2M`) or a full shared invitation URL.
 */
export function parseInviteOrRoomTarget(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  if (trimmed.includes('/room/')) {
    try {
      const url = new URL(trimmed.startsWith('http') ? trimmed : `https://placeholder.local${trimmed.startsWith('/') ? '' : '/'}${trimmed}`);
      const match = url.pathname.match(/\/room\/([A-Za-z0-9-]{4,12})/i);
      if (match) {
        const code = match[1].toUpperCase();
        return `/room/${encodeURIComponent(code)}${url.search || ''}`;
      }
    } catch {
      // Fall back to direct code parsing
    }
  }

  return `/room/${encodeURIComponent(trimmed.toUpperCase())}`;
}

export async function copyTextSafely(text: string): Promise<boolean> {
  if (typeof window === 'undefined' || !text) return false;

  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function isLikelyMobileTouchDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const coarsePointer = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  return coarsePointer || mobileUa;
}

export async function shareInviteLink(opts: {
  title: string;
  text: string;
  url: string;
}): Promise<{ outcome: 'shared' | 'copied' | 'cancelled' | 'failed'; message: string }> {
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    isLikelyMobileTouchDevice()
  ) {
    try {
      await navigator.share({
        title: opts.title,
        text: opts.text,
        url: opts.url
      });
      return { outcome: 'shared', message: 'Invite shared successfully!' };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return { outcome: 'cancelled', message: 'Share cancelled.' };
      }
      // Fall through to clipboard fallback cleanly
    }
  }

  const copied = await copyTextSafely(opts.url);
  if (copied) {
    return { outcome: 'copied', message: 'Invite link copied to clipboard!' };
  }
  return {
    outcome: 'failed',
    message: 'Clipboard access blocked by browser. Copy the invite URL shown manually.'
  };
}

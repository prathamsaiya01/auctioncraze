'use client';

let audioCtx: AudioContext | null = null;

export interface AuctionMediaPrefs {
  isMuted: boolean;
  volume: number;
  reducedMotion: boolean;
}

const PREFS_STORAGE_KEY = 'auctioncraze_audio_prefs';

export const DEFAULT_MEDIA_PREFS: AuctionMediaPrefs = {
  isMuted: false,
  volume: 0.65,
  reducedMotion: false
};

export function loadAudioPrefs(): AuctionMediaPrefs {
  if (typeof window === 'undefined') return DEFAULT_MEDIA_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_MEDIA_PREFS;
    const parsed = JSON.parse(raw);
    return {
      isMuted: Boolean(parsed?.isMuted),
      volume:
        typeof parsed?.volume === 'number' && !Number.isNaN(parsed.volume)
          ? Math.max(0, Math.min(1, parsed.volume))
          : DEFAULT_MEDIA_PREFS.volume,
      reducedMotion: Boolean(parsed?.reducedMotion)
    };
  } catch {
    return DEFAULT_MEDIA_PREFS;
  }
}

export function saveAudioPrefs(prefs: AuctionMediaPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota / private mode failures
  }
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/**
 * Unlocks the Web Audio API context smoothly on the user's first pointer/key gesture
 * so real-time auction cues are allowed under strict browser autoplay policies.
 */
export function unlockAudioContext(): void {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  } catch {
    // Ignore autoplay errors
  }
}

function playTone(
  ctx: AudioContext,
  opts: {
    type: OscillatorType;
    startFreq: number;
    endFreq?: number;
    delay?: number;
    duration: number;
    peakGain: number;
  }
) {
  const start = ctx.currentTime + (opts.delay || 0);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = opts.type;
  osc.frequency.setValueAtTime(opts.startFreq, start);
  if (opts.endFreq && opts.endFreq !== opts.startFreq) {
    osc.frequency.exponentialRampToValueAtTime(opts.endFreq, start + opts.duration);
  }
  gain.gain.setValueAtTime(0.001, start);
  gain.gain.linearRampToValueAtTime(Math.max(0.002, opts.peakGain), start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, start + opts.duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + opts.duration + 0.02);
}

function gavelStrike(ctx: AudioContext, startTime: number, gainLevel: number) {
  const osc = ctx.createOscillator();
  const oscGain = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(320, startTime);
  osc.frequency.exponentialRampToValueAtTime(72, startTime + 0.13);

  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(260, startTime);
  filter.Q.setValueAtTime(3.4, startTime);

  oscGain.gain.setValueAtTime(0.001, startTime);
  oscGain.gain.linearRampToValueAtTime(0.8 * gainLevel, startTime + 0.005);
  oscGain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.15);

  osc.connect(filter);
  filter.connect(oscGain);
  oscGain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + 0.16);
}

/** 1. Short, subtle sound when another franchise places a bid */
export function playBidReceived(isMuted: boolean, volume = 0.6): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    playTone(ctx, {
      type: 'sine',
      startFreq: 540,
      endFreq: 640,
      duration: 0.11,
      peakGain: 0.18 * volume
    });
  } catch {
    // Ignore autoplay restriction
  }
}

/** 2. Distinct confirmation chime when a new highest bid takes the spotlight */
export function playNewHighestBid(isMuted: boolean, volume = 0.65): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    playTone(ctx, {
      type: 'sine',
      startFreq: 660,
      duration: 0.1,
      peakGain: 0.24 * volume
    });
    playTone(ctx, {
      type: 'triangle',
      startFreq: 990,
      delay: 0.065,
      duration: 0.18,
      peakGain: 0.28 * volume
    });
  } catch {
    // Ignore autoplay restriction
  }
}

export const playBidChime = playNewHighestBid;

/** 3. Increasingly urgent countdown tick in final seconds */
export function playCountdownTick(isMuted: boolean, volume = 0.5, secondsLeft = 3): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const freq = secondsLeft <= 1 ? 1320 : secondsLeft === 2 ? 1080 : 880;
    const gainBoost = secondsLeft <= 1 ? 0.24 : secondsLeft === 2 ? 0.18 : 0.13;
    playTone(ctx, {
      type: 'triangle',
      startFreq: freq,
      duration: secondsLeft <= 1 ? 0.085 : 0.06,
      peakGain: gainBoost * volume
    });
  } catch {
    // Ignore autoplay restriction
  }
}

/** 4. Short bright extension cue when countdown resets/extends on late bid or host action */
export function playTimerExtended(isMuted: boolean, volume = 0.6): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    playTone(ctx, {
      type: 'sine',
      startFreq: 587,
      duration: 0.08,
      peakGain: 0.18 * volume
    });
    playTone(ctx, {
      type: 'sine',
      startFreq: 880,
      delay: 0.075,
      duration: 0.14,
      peakGain: 0.2 * volume
    });
  } catch {
    // Ignore autoplay restriction
  }
}

/** 5. Auction gavel hammer + bell resonance for SOLD */
export function playSoldGavel(isMuted: boolean, volume = 0.7): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    gavelStrike(ctx, now, 0.7 * volume);
    gavelStrike(ctx, now + 0.17, 0.75 * volume);
    gavelStrike(ctx, now + 0.36, 1.0 * volume);
    playTone(ctx, {
      type: 'sine',
      startFreq: 523.25,
      delay: 0.36,
      duration: 0.38,
      peakGain: 0.16 * volume
    });
  } catch {
    // Ignore autoplay restriction
  }
}

/** 6. Lower-intensity descending tone for UNSOLD */
export function playUnsoldTone(isMuted: boolean, volume = 0.6): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    playTone(ctx, {
      type: 'sawtooth',
      startFreq: 240,
      endFreq: 130,
      duration: 0.3,
      peakGain: 0.18 * volume
    });
  } catch {
    // Ignore autoplay restriction
  }
}

/** 7A. Auction paused cue */
export function playAuctionPaused(isMuted: boolean, volume = 0.55): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    playTone(ctx, {
      type: 'sine',
      startFreq: 520,
      endFreq: 350,
      duration: 0.2,
      peakGain: 0.18 * volume
    });
  } catch {
    // Ignore autoplay restriction
  }
}

/** 7B. Auction resumed cue */
export function playAuctionResumed(isMuted: boolean, volume = 0.55): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    playTone(ctx, {
      type: 'sine',
      startFreq: 370,
      endFreq: 620,
      duration: 0.2,
      peakGain: 0.2 * volume
    });
  } catch {
    // Ignore autoplay restriction
  }
}

/** 8. New player spotlight introduction cue */
export function playNewPlayerIntro(isMuted: boolean, volume = 0.6): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    playTone(ctx, {
      type: 'triangle',
      startFreq: 392,
      duration: 0.1,
      peakGain: 0.16 * volume
    });
    playTone(ctx, {
      type: 'triangle',
      startFreq: 523.25,
      delay: 0.08,
      duration: 0.12,
      peakGain: 0.18 * volume
    });
    playTone(ctx, {
      type: 'sine',
      startFreq: 659.25,
      delay: 0.17,
      duration: 0.22,
      peakGain: 0.2 * volume
    });
  } catch {
    // Ignore autoplay restriction
  }
}

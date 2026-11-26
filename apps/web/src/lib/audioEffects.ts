let audioCtx: AudioContext | null = null;

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

function gavelStrike(ctx: AudioContext, startTime: number, gainLevel: number) {
  const osc = ctx.createOscillator();
  const oscGain = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(310, startTime);
  osc.frequency.exponentialRampToValueAtTime(75, startTime + 0.12);

  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(260, startTime);
  filter.Q.setValueAtTime(3.2, startTime);

  oscGain.gain.setValueAtTime(0.001, startTime);
  oscGain.gain.linearRampToValueAtTime(0.8 * gainLevel, startTime + 0.004);
  oscGain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.14);

  osc.connect(filter);
  filter.connect(oscGain);
  oscGain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + 0.15);
}

export function playBidChime(isMuted: boolean, volume = 0.6): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.setValueAtTime(880, now + 0.06);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.25 * volume, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.28);
  } catch {
    // Ignore autoplay restriction
  }
}

export function playSoldGavel(isMuted: boolean, volume = 0.7): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    gavelStrike(ctx, now, 0.7 * volume);
    gavelStrike(ctx, now + 0.17, 0.75 * volume);
    gavelStrike(ctx, now + 0.36, 1.0 * volume);
  } catch {
    // Ignore autoplay restriction
  }
}

export function playUnsoldTone(isMuted: boolean, volume = 0.6): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(130, now + 0.3);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.2 * volume, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.35);
  } catch {
    // Ignore autoplay restriction
  }
}

export function playCountdownTick(isMuted: boolean, volume = 0.5): void {
  if (isMuted || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1040, now);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.14 * volume, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.065);
  } catch {
    // Ignore autoplay restriction
  }
}

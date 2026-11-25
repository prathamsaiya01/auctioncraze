import crypto from 'crypto';

// Unambiguous uppercase alphabet (excludes 0, O, 1, I, L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRoomCode(length = 6): string {
  const bytes = crypto.randomBytes(length);
  let suffix = '';
  for (let i = 0; i < length; i++) {
    suffix += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `AC-${suffix}`;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackOrigin(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Resolves Next.js root `metadataBase` without emitting localhost URLs in production builds.
 * In production, prefers `NEXT_PUBLIC_APP_URL` and falls back to Netlify's deploy origin (`URL` / `DEPLOY_PRIME_URL`)
 * only when the origin is non-loopback HTTP(S).
 */
export function resolveMetadataBase(
  env: Record<string, string | undefined> = process.env
): URL | undefined {
  const isProd = env.NODE_ENV === 'production';
  const candidates = [env.NEXT_PUBLIC_APP_URL, env.URL, env.DEPLOY_PRIME_URL];

  for (const raw of candidates) {
    const trimmed = raw?.trim().replace(/\/+$/, '');
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        continue;
      }
      if (isProd && isLoopbackOrigin(trimmed)) {
        continue;
      }
      return parsed;
    } catch {
      continue;
    }
  }

  return undefined;
}

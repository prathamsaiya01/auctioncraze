import { prisma } from '@auctioncraze/database';
import { config } from '../../config/env';
import { AppError } from '../../middleware/errorHandler';

const SENSITIVE_INTERNAL_KEYS = new Set([
  'artifact_path',
  'dataset_fingerprint',
  'holdout_metrics',
  'validation_metrics',
  'validation_candidates',
  'baseline_comparisons',
  'selected_candidate',
  'feature_breakdown',
  'team_elo',
  'sample_counts'
]);

export function scrubSensitiveFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => scrubSensitiveFields(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_INTERNAL_KEYS.has(k)) continue;
      out[k] = scrubSensitiveFields(v);
    }
    return out as T;
  }
  return value;
}

export async function callMlService<T = unknown>(
  path: string,
  options?: { method?: string; body?: unknown }
): Promise<T> {
  if (!config.enableMlService) {
    throw new AppError(
      'Cricket intelligence (ML) is disabled in zero-cost mode. Live auctions, rooms, trading, chat, and seasons remain fully active.',
      503,
      'ML_SERVICE_DISABLED'
    );
  }

  const internalKey = config.internalMlServiceKey;
  if (!internalKey || internalKey.length < 32) {
    throw new AppError(
      'Internal ML service secret is missing (failing closed).',
      503,
      'INTERNAL_ML_AUTH_MISSING'
    );
  }

  const url = `${config.mlServiceUrl.replace(/\/+$/, '')}${path}`;
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: options?.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': internalKey
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    throw new AppError(
      'Cricket intelligence service is currently offline or unreachable.',
      503,
      'ML_SERVICE_UNAVAILABLE'
    );
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail =
      (payload && (payload.detail || payload.message)) ||
      `ML service error (${response.status})`;
    const code =
      response.status === 503
        ? 'MODEL_UNAVAILABLE'
        : response.status === 422
        ? 'INSUFFICIENT_OR_INVALID_INPUT'
        : response.status === 404
        ? 'NOT_FOUND'
        : response.status === 401 || response.status === 403
        ? 'ML_INTERNAL_UNAUTHORIZED'
        : 'ML_REQUEST_FAILED';
    throw new AppError(String(detail), response.status, code);
  }

  return scrubSensitiveFields(payload as T);
}

export async function resolvePlayerKeyForMl(idOrKey: string): Promise<string> {
  const trimmed = idOrKey.trim();
  const found = await prisma.masterPlayer.findFirst({
    where: {
      OR: [
        { id: trimmed },
        { cricsheetId: trimmed },
        { externalKey: trimmed },
        { fullName: { equals: trimmed, mode: 'insensitive' } }
      ]
    },
    select: {
      cricsheetId: true,
      externalKey: true,
      fullName: true
    }
  });

  if (!found) {
    return trimmed;
  }
  return found.cricsheetId || found.externalKey || found.fullName;
}

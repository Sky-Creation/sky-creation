/* Shared, privacy-preserving rate limiting for Netlify Functions.
 *
 * Production uses Upstash's HTTP client, which suits short-lived functions.
 * Imports stay inside createProductionRateLimiter() so Node's source-only test
 * suite never needs production dependencies installed. Factories accept a
 * small limiter interface, allowing deterministic unit tests without a network.
 */

import { createHmac } from 'node:crypto';

/** Only for injected / SKY_EXCHANGE_TEST servers. Never a production fallback. */
export const TEST_RATE_LIMIT_HMAC_KEY = 'test-only-rate-limit-key-that-is-never-deployed';

export class RateLimiterError extends Error {
  constructor(status, message, retryAfter = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Resolve the HMAC key used to hash IPs before they hit the limiter.
 * Production must set RATE_LIMIT_HMAC_KEY (>= 32 chars). The test default is
 * only returned when allowTestDefault is true. */
export function resolveRateLimitHmacKey(env = {}, { allowTestDefault = false } = {}) {
  const key = String((env && env.RATE_LIMIT_HMAC_KEY) || '');
  if (key.length >= 32) return key;
  if (allowTestDefault) return TEST_RATE_LIMIT_HMAC_KEY;
  throw new RateLimiterError(503, 'Rate limiting is not configured');
}

export function hashRateLimitIdentifier(value, key) {
  if (typeof key !== 'string' || key.length < 32) {
    throw new RateLimiterError(503, 'Rate limiting is not configured');
  }
  return createHmac('sha256', key).update(String(value || 'unknown')).digest('hex');
}

/* This deliberately exists only for explicitly injected test servers. The
 * deployed handlers always initialise the Upstash limiter and fail closed if
 * that is unavailable. */
export function createMemoryRateLimiter(now = () => Date.now()) {
  const hits = new Map();
  return {
    async limit(namespace, identifier, max, windowSeconds) {
      const key = `${namespace}:${identifier}`;
      const at = now();
      const windowMs = windowSeconds * 1000;
      const recent = (hits.get(key) || []).filter((time) => at - time < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return { success: false, reset: recent[0] + windowMs };
      }
      recent.push(at);
      hits.set(key, recent);
      return { success: true, reset: recent[0] + windowMs };
    },
  };
}

export async function enforceRateLimit({ limiter, namespace, ip, max, windowSeconds, hmacKey }) {
  if (!limiter || typeof limiter.limit !== 'function') {
    throw new RateLimiterError(503, 'Rate limiting is unavailable');
  }

  const identifier = hashRateLimitIdentifier(ip, hmacKey);
  let result;
  try {
    result = await limiter.limit(namespace, identifier, max, windowSeconds);
  } catch (err) {
    if (err instanceof RateLimiterError) throw err;
    console.error('rate-limit: provider request failed', err && err.message ? err.message : err);
    throw new RateLimiterError(503, 'Rate limiting is unavailable');
  }
  if (!result || typeof result.success !== 'boolean') {
    console.error('rate-limit: provider returned an invalid result');
    throw new RateLimiterError(503, 'Rate limiting is unavailable');
  }
  if (!result.success) {
    const reset = Number(result.reset);
    const retryAfter = Number.isFinite(reset)
      ? Math.max(1, Math.ceil((reset - Date.now()) / 1000))
      : windowSeconds;
    throw new RateLimiterError(429, 'Too many requests. Try again later.', retryAfter);
  }
  return identifier;
}

export async function createProductionRateLimiter(env = process.env) {
  const url = String(env.UPSTASH_REDIS_REST_URL || '');
  const token = String(env.UPSTASH_REDIS_REST_TOKEN || '');
  if (!url || !token) {
    throw new RateLimiterError(503, 'Rate limiting is not configured');
  }

  try {
    const [{ Redis }, { Ratelimit }] = await Promise.all([
      import('@upstash/redis'),
      import('@upstash/ratelimit'),
    ]);
    const redis = new Redis({ url, token });
    const limiters = new Map();
    return {
      async limit(namespace, identifier, max, windowSeconds) {
        const key = `${namespace}:${max}:${windowSeconds}`;
        let limiter = limiters.get(key);
        if (!limiter) {
          limiter = new Ratelimit({
            redis,
            prefix: 'sky-creation-rate-limit',
            limiter: Ratelimit.slidingWindow(max, `${windowSeconds} s`),
          });
          limiters.set(key, limiter);
        }
        return limiter.limit(`${namespace}:${identifier}`);
      },
    };
  } catch (err) {
    console.error('rate-limit: could not initialise Upstash', err && err.message ? err.message : err);
    throw new RateLimiterError(503, 'Rate limiting is unavailable');
  }
}

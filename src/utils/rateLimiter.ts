/**
 * Simple in-memory rate limiter using sliding window.
 * Resets on cold start (per Worker instance).
 */
export interface RateLimitResult {
  limited: boolean;
  remaining: number;
  resetAfterSeconds: number;
  limit: number;
  current: number;
}

export function checkRateLimit(
  countsMap: Map<string, number[]>,
  ip: string,
  windowMs: number,
  maxRequests: number
): RateLimitResult {
  const now = Date.now();
  const timestamps = countsMap.get(ip) || [];
  const filtered = timestamps.filter(t => now - t < windowMs);

  if (filtered.length >= maxRequests) {
    countsMap.set(ip, filtered);
    const oldest = filtered[0] || now;
    const resetAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    return {
      limited: true,
      remaining: 0,
      resetAfterSeconds,
      limit: maxRequests,
      current: filtered.length,
    };
  }

  filtered.push(now);
  countsMap.set(ip, filtered);

  return {
    limited: false,
    remaining: Math.max(0, maxRequests - filtered.length),
    resetAfterSeconds: Math.ceil(windowMs / 1000),
    limit: maxRequests,
    current: filtered.length,
  };
}

export function isRateLimited(
  countsMap: Map<string, number[]>,
  ip: string,
  windowMs: number,
  maxRequests: number
): boolean {
  return checkRateLimit(countsMap, ip, windowMs, maxRequests).limited;
}

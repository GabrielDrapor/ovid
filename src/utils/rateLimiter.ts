/**
 * Simple in-memory rate limiter using sliding window.
 * Resets on cold start (per Worker instance).
 */
export function isRateLimited(
  countsMap: Map<string, number[]>,
  ip: string,
  windowMs: number,
  maxRequests: number
): boolean {
  const now = Date.now();
  const timestamps = countsMap.get(ip) || [];
  const filtered = timestamps.filter(t => now - t < windowMs);
  if (filtered.length >= maxRequests) {
    countsMap.set(ip, filtered);
    return true;
  }
  filtered.push(now);
  countsMap.set(ip, filtered);
  return false;
}

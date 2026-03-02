import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isRateLimited } from '../../../src/utils/rateLimiter';

describe('isRateLimited', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under limit', () => {
    const map = new Map<string, number[]>();
    // 3 requests with limit of 5 — should all pass
    expect(isRateLimited(map, '1.2.3.4', 60_000, 5)).toBe(false);
    expect(isRateLimited(map, '1.2.3.4', 60_000, 5)).toBe(false);
    expect(isRateLimited(map, '1.2.3.4', 60_000, 5)).toBe(false);
  });

  it('blocks requests over limit', () => {
    const map = new Map<string, number[]>();
    for (let i = 0; i < 3; i++) {
      isRateLimited(map, '1.2.3.4', 60_000, 3);
    }
    // 4th request should be blocked
    expect(isRateLimited(map, '1.2.3.4', 60_000, 3)).toBe(true);
  });

  it('resets after window expires', () => {
    const map = new Map<string, number[]>();
    // Fill up the limit
    for (let i = 0; i < 3; i++) {
      isRateLimited(map, '1.2.3.4', 60_000, 3);
    }
    expect(isRateLimited(map, '1.2.3.4', 60_000, 3)).toBe(true);

    // Advance past window
    vi.advanceTimersByTime(61_000);
    expect(isRateLimited(map, '1.2.3.4', 60_000, 3)).toBe(false);
  });

  it('tracks different IPs independently', () => {
    const map = new Map<string, number[]>();
    for (let i = 0; i < 3; i++) {
      isRateLimited(map, '1.1.1.1', 60_000, 3);
    }
    expect(isRateLimited(map, '1.1.1.1', 60_000, 3)).toBe(true);
    // Different IP should still be allowed
    expect(isRateLimited(map, '2.2.2.2', 60_000, 3)).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from '../../../src/utils/fetchWithRetry';

describe('fetchWithRetry', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('succeeds on first try', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

    const res = await fetchWithRetry('http://example.com');
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 4xx', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));

    const res = await fetchWithRetry('http://example.com');
    expect(res.status).toBe(404);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx and eventually succeeds', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockResolvedValueOnce(new Response('error', { status: 502 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    global.fetch = mockFetch;

    const promise = fetchWithRetry('http://example.com');
    // Advance through backoff delays
    await vi.advanceTimersByTimeAsync(300);  // first retry
    await vi.advanceTimersByTimeAsync(900);  // second retry
    const res = await promise;

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('retries on network error and eventually succeeds', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    global.fetch = mockFetch;

    const promise = fetchWithRetry('http://example.com');
    await vi.advanceTimersByTimeAsync(300);
    const res = await promise;

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries exhausted on network error', async () => {
    vi.useRealTimers();
    global.fetch = vi.fn().mockImplementation(() => Promise.reject(new Error('network error')));

    // Use maxRetries=0 to avoid long waits
    await expect(fetchWithRetry('http://example.com', undefined, 0)).rejects.toThrow('network error');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns last 5xx response after max retries', async () => {
    vi.useRealTimers();
    global.fetch = vi.fn().mockResolvedValue(new Response('error', { status: 503 }));

    // Use maxRetries=1 with short backoff
    const res = await fetchWithRetry('http://example.com', undefined, 1);

    expect(res.status).toBe(503);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

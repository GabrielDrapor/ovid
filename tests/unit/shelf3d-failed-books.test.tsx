import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useChaptersAvailable } from '../../src/components/shelf3d/useChaptersAvailable';
import { processingTitleInk } from '../../src/components/shelf3d/fallbackTextures';

const reply = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );

afterEach(() => vi.restoreAllMocks());

describe('reading a book whose translation failed', () => {
  it('is offered when its chapters were saved', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockImplementation(() => reply([{ chapter_number: 1 }]));
    const { result } = renderHook(() => useChaptersAvailable('failed-1'));
    await waitFor(() => expect(result.current).toBe(true));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/book/failed-1/chapters');
  });

  it('is not offered when nothing was saved', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => reply([]));
    const { result } = renderHook(() => useChaptersAvailable('failed-2'));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBe(false);
  });

  it('is not offered when the request fails', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(() =>
      reply({ error: 'Not found' }, 404)
    );
    const { result } = renderHook(() => useChaptersAvailable('failed-3'));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBe(false);
  });

  it('asks nothing for other books', () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    renderHook(() => useChaptersAvailable(null));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('title on a spine still being prepared', () => {
  it('is dark while the spine is pale, light once it darkens', () => {
    expect(processingTitleInk(0)).toMatch(/^rgba\(58, 53, 45/);
    expect(processingTitleInk(0.9)).toMatch(/^rgba\(255, 250, 240/);
  });
});

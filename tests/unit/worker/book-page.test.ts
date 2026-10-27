import { describe, it, expect, vi, beforeEach } from 'vitest';

// The page route for /book/:uuid serves the app. A book that doesn't exist
// used to redirect to the shelf, which left the reader with no explanation.

function createEnv(lookup: () => Promise<unknown>) {
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(() =>
      sql.includes('FROM books_v2 WHERE uuid')
        ? lookup()
        : Promise.resolve(null)
    ),
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  }));
  return {
    DB: { prepare },
    ASSETS: {
      fetch: vi.fn(
        async () =>
          new Response('<div id="root"></div>', {
            headers: { 'Content-Type': 'text/html' },
          })
      ),
    },
  } as any;
}

async function loadWorker() {
  vi.resetModules();
  return (await import('../../../src/worker/index')).default;
}

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any;
const open = async (env: any, path: string) =>
  (await loadWorker()).fetch(new Request(`https://ovid.ink${path}`), env, ctx);

describe('book page route', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('serves the app for a book that exists', async () => {
    const res = await open(
      createEnv(async () => ({ uuid: 'abc' })),
      '/book/abc'
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it('serves the app with a 404 for a book that does not exist', async () => {
    const res = await open(
      createEnv(async () => null),
      '/book/missing'
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('id="root"');
  });

  it('serves the app when the lookup fails, leaving the answer to the API', async () => {
    const res = await open(
      createEnv(async () => {
        throw new Error('D1 unavailable');
      }),
      '/v2/book/abc'
    );
    expect(res.status).toBe(200);
  });
});

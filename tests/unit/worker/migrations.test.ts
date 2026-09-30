import { describe, it, expect, vi, beforeEach } from 'vitest';

const MIGRATIONS_TABLE_SQL = 'CREATE TABLE IF NOT EXISTS _migrations';

function createMockDB(options: { failMigrationsTable?: () => boolean } = {}) {
  const prepare = vi.fn((sql: string) => {
    const statement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn(async () => {
        if (
          sql.includes(MIGRATIONS_TABLE_SQL) &&
          options.failMigrationsTable?.()
        ) {
          throw new Error('D1_ERROR: Network connection lost.');
        }
        return { success: true, meta: { changes: 1 } };
      }),
    };
    return statement;
  });
  return { prepare } as any;
}

function createEnv(db: any) {
  return {
    DB: db,
    ASSETS: {
      fetch: vi
        .fn()
        .mockResolvedValue(new Response('Not found', { status: 404 })),
    },
  } as any;
}

const migrationsTableRuns = (db: any) =>
  db.prepare.mock.calls.filter(([sql]: [string]) =>
    sql.includes(MIGRATIONS_TABLE_SQL)
  ).length;

// The migration promise is module state, so each test loads a fresh worker module
// (the equivalent of a freshly started isolate).
async function loadWorker() {
  vi.resetModules();
  return (await import('../../../src/worker/index')).default;
}

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any;

describe('worker migrations', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('runs migrations once when concurrent API requests hit a fresh isolate', async () => {
    const worker = await loadWorker();
    const db = createMockDB();
    const env = createEnv(db);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        worker.fetch(
          new Request('https://ovid.ink/api/does-not-exist'),
          env,
          ctx
        )
      )
    );

    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(404));
    expect(migrationsTableRuns(db)).toBe(1);

    const preparesBefore = db.prepare.mock.calls.length;
    await worker.fetch(
      new Request('https://ovid.ink/api/does-not-exist'),
      env,
      ctx
    );
    expect(db.prepare.mock.calls.length).toBe(preparesBefore);
  });

  it('serves non-API unknown paths without touching D1', async () => {
    const worker = await loadWorker();
    const db = createMockDB();
    const env = createEnv(db);

    const response = await worker.fetch(
      new Request('https://ovid.ink/webpack-stats.json'),
      env,
      ctx
    );

    expect(response.status).toBe(302);
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('returns a JSON 503 when migrations fail and retries on a later request', async () => {
    const worker = await loadWorker();
    let fail = true;
    const db = createMockDB({ failMigrationsTable: () => fail });
    const env = createEnv(db);

    const failed = await worker.fetch(
      new Request('https://ovid.ink/api/does-not-exist'),
      env,
      ctx
    );
    expect(failed.status).toBe(503);
    expect(failed.headers.get('Content-Type')).toBe('application/json');
    expect(failed.headers.get('Retry-After')).toBe('5');
    const body = (await failed.json()) as Record<string, unknown>;
    expect(body.code).toBe('MIGRATIONS_UNAVAILABLE');
    expect(body.requestId).toBeTruthy();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('D1_ERROR: Network connection lost.')
    );

    fail = false;
    const recovered = await worker.fetch(
      new Request('https://ovid.ink/api/does-not-exist'),
      env,
      ctx
    );
    expect(recovered.status).toBe(404);
    expect(migrationsTableRuns(db)).toBe(2);
  });
});

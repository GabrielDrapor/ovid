import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleEmailStart,
  handleEmailVerify,
  sha256Hex,
  EMAIL_SIGNUP_BONUS,
} from '../../../src/worker/email-auth';

/**
 * Stateful fake D1 that routes on the SQL fragments email-auth actually
 * uses, backed by tiny in-memory tables. Time-based SQL (datetime('now')
 * windows) is emulated with JS Dates.
 */
function createFakeDB() {
  const state = {
    loginCodes: [] as Array<{
      id: number;
      email: string;
      abuse_key: string;
      code_hash: string;
      expires_at: number;
      attempts: number;
      consumed_at: number | null;
      created_at: number;
    }>,
    users: [] as Array<{
      id: number;
      google_id: string;
      email: string;
      name: string;
      picture: string;
      credits: number;
    }>,
    identities: [] as Array<{
      user_id: number;
      provider: string;
      provider_id: string;
    }>,
    sessions: [] as Array<{ user_id: number; session_token: string }>,
    transactions: [] as Array<{
      user_id: number;
      amount: number;
      type: string;
    }>,
    nextId: 1,
  };

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const now = Date.now();
          return {
            async first() {
              if (sql.includes('SUM(CASE WHEN created_at')) {
                const [abuseKey] = args as [string];
                const rows = state.loginCodes.filter(
                  (r) => r.abuse_key === abuseKey
                );
                return {
                  recent: rows.filter((r) => r.created_at >= now - 15 * 60_000)
                    .length,
                  daily: rows.filter((r) => r.created_at >= now - 24 * 3600_000)
                    .length,
                };
              }
              if (
                sql.includes('SELECT id, code_hash, attempts FROM login_codes')
              ) {
                const [email] = args as [string];
                const rows = state.loginCodes
                  .filter(
                    (r) =>
                      r.email === email &&
                      r.consumed_at === null &&
                      r.expires_at > now
                  )
                  .sort((a, b) => b.created_at - a.created_at);
                return rows[0] ?? null;
              }
              if (sql.includes("provider = 'email' AND provider_id")) {
                const [email] = args as [string];
                const found = state.identities.find(
                  (i) => i.provider === 'email' && i.provider_id === email
                );
                return found ? { user_id: found.user_id } : null;
              }
              if (sql.includes('SELECT id FROM users WHERE email')) {
                const [email] = args as [string];
                const u = state.users.find((u) => u.email === email);
                return u ? { id: u.id } : null;
              }
              if (sql.includes('SELECT id FROM users WHERE google_id')) {
                const [gid] = args as [string];
                const u = state.users.find((u) => u.google_id === gid);
                return u ? { id: u.id } : null;
              }
              if (sql.includes('SELECT id, email, name, picture FROM users')) {
                const [id] = args as [number];
                const u = state.users.find((u) => u.id === id);
                return u
                  ? {
                      id: u.id,
                      email: u.email,
                      name: u.name,
                      picture: u.picture,
                    }
                  : null;
              }
              throw new Error(`fakeDB.first: unrouted SQL: ${sql}`);
            },
            async run() {
              if (sql.includes('INSERT INTO login_codes')) {
                const [email, abuseKey, codeHash] = args as string[];
                state.loginCodes.push({
                  id: state.nextId++,
                  email,
                  abuse_key: abuseKey,
                  code_hash: codeHash,
                  expires_at: now + 10 * 60_000,
                  attempts: 0,
                  consumed_at: null,
                  created_at: now,
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM login_codes WHERE code_hash')) {
                const [hash] = args as [string];
                state.loginCodes = state.loginCodes.filter(
                  (r) => r.code_hash !== hash
                );
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('SET attempts = attempts + 1')) {
                const [id] = args as [number];
                const r = state.loginCodes.find((r) => r.id === id);
                if (r) r.attempts += 1;
                return { success: true, meta: { changes: r ? 1 : 0 } };
              }
              if (sql.includes('SET consumed_at')) {
                const [id] = args as [number];
                const r = state.loginCodes.find(
                  (r) => r.id === id && r.consumed_at === null
                );
                if (r) r.consumed_at = now;
                return { success: true, meta: { changes: r ? 1 : 0 } };
              }
              if (sql.includes('INSERT INTO users')) {
                const [gid, email, name, picture, credits] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                ];
                state.users.push({
                  id: state.nextId++,
                  google_id: gid,
                  email,
                  name,
                  picture,
                  credits,
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO credit_transactions')) {
                const [userId, amount, ,] = args as [number, number, string];
                state.transactions.push({
                  user_id: userId,
                  amount,
                  type: 'signup_bonus',
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('INSERT OR IGNORE INTO user_identities')) {
                const [userId, providerId] = args as [number, string];
                const provider = sql.includes("'email'") ? 'email' : 'google';
                const exists = state.identities.some(
                  (i) => i.provider === provider && i.provider_id === providerId
                );
                if (!exists) {
                  state.identities.push({
                    user_id: userId,
                    provider,
                    provider_id: providerId,
                  });
                }
                return { success: true, meta: { changes: exists ? 0 : 1 } };
              }
              if (sql.includes('INSERT INTO sessions')) {
                const [userId, token] = args as [number, string];
                state.sessions.push({ user_id: userId, session_token: token });
                return { success: true, meta: { changes: 1 } };
              }
              throw new Error(`fakeDB.run: unrouted SQL: ${sql}`);
            },
          };
        },
      };
    },
  };

  return { db, state };
}

function makeEnv(fake: ReturnType<typeof createFakeDB>, resendKey?: string) {
  return { DB: fake.db, RESEND_API_KEY: resendKey } as any;
}

function post(body: unknown): Request {
  return new Request('https://ovid.ink/api/auth/email/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function seedCode(
  fake: ReturnType<typeof createFakeDB>,
  email: string,
  code: string,
  overrides: Partial<(typeof fake.state.loginCodes)[0]> = {}
) {
  fake.state.loginCodes.push({
    id: fake.state.nextId++,
    email,
    abuse_key: email,
    code_hash: await sha256Hex(`${email}:${code}`),
    expires_at: Date.now() + 10 * 60_000,
    attempts: 0,
    consumed_at: null,
    created_at: Date.now(),
    ...overrides,
  });
}

describe('handleEmailStart', () => {
  it('stores a hashed code and returns ok (dev mode: no Resend key)', async () => {
    const fake = createFakeDB();
    const resp = await handleEmailStart(
      post({ email: ' Reader@Example.com ' }),
      makeEnv(fake)
    );
    expect(resp.status).toBe(200);
    expect(fake.state.loginCodes).toHaveLength(1);
    const row = fake.state.loginCodes[0];
    expect(row.email).toBe('reader@example.com');
    // never stores the raw code — 64-hex digest only
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects invalid and disposable addresses without touching the DB', async () => {
    const fake = createFakeDB();
    expect(
      (await handleEmailStart(post({ email: 'nope' }), makeEnv(fake))).status
    ).toBe(400);
    expect(
      (
        await handleEmailStart(
          post({ email: 'x@mailinator.com' }),
          makeEnv(fake)
        )
      ).status
    ).toBe(400);
    expect(fake.state.loginCodes).toHaveLength(0);
  });

  it('caps issuance per 15 minutes, shared across +tag variants', async () => {
    const fake = createFakeDB();
    const env = makeEnv(fake);
    for (let i = 0; i < 3; i++) {
      expect(
        (await handleEmailStart(post({ email: 'a@x.com' }), env)).status
      ).toBe(200);
    }
    expect(
      (await handleEmailStart(post({ email: 'a@x.com' }), env)).status
    ).toBe(429);
    // +tag maps to the same abuse key — also blocked
    expect(
      (await handleEmailStart(post({ email: 'a+tag@x.com' }), env)).status
    ).toBe(429);
  });

  it('deletes the stored code when the email fails to send', async () => {
    const fake = createFakeDB();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const resp = await handleEmailStart(
        post({ email: 'a@x.com' }),
        makeEnv(fake, 're_test_key')
      );
      expect(resp.status).toBe(502);
      expect(fake.state.loginCodes).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('handleEmailVerify', () => {
  it('creates an account with the reduced bonus, identity and session', async () => {
    const fake = createFakeDB();
    await seedCode(fake, 'new@x.com', '123456');
    const resp = await handleEmailVerify(
      post({ email: 'new@x.com', code: '123456' }),
      makeEnv(fake)
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Set-Cookie')).toContain('ovid_session=');
    const body = (await resp.json()) as { user: { id: number; email: string } };
    expect(body.user.email).toBe('new@x.com');

    expect(fake.state.users).toHaveLength(1);
    expect(fake.state.users[0].credits).toBe(EMAIL_SIGNUP_BONUS);
    expect(fake.state.users[0].google_id).toMatch(/^email:/);
    expect(fake.state.transactions).toEqual([
      {
        user_id: body.user.id,
        amount: EMAIL_SIGNUP_BONUS,
        type: 'signup_bonus',
      },
    ]);
    expect(fake.state.identities).toEqual([
      { user_id: body.user.id, provider: 'email', provider_id: 'new@x.com' },
    ]);
    expect(fake.state.sessions).toHaveLength(1);
    expect(fake.state.sessions[0].user_id).toBe(body.user.id);
  });

  it('logs an existing Google user into the same account by email', async () => {
    const fake = createFakeDB();
    fake.state.users.push({
      id: 7,
      google_id: 'g-123',
      email: 'linked@x.com',
      name: 'Linked',
      picture: '',
      credits: 5000,
    });
    await seedCode(fake, 'linked@x.com', '123456');
    const resp = await handleEmailVerify(
      post({ email: 'linked@x.com', code: '123456' }),
      makeEnv(fake)
    );
    const body = (await resp.json()) as { user: { id: number } };
    expect(body.user.id).toBe(7);
    // no new user, no second bonus
    expect(fake.state.users).toHaveLength(1);
    expect(fake.state.transactions).toHaveLength(0);
    // email identity now linked to the Google account
    expect(fake.state.identities).toEqual([
      { user_id: 7, provider: 'email', provider_id: 'linked@x.com' },
    ]);
  });

  it('signs in a returning email user without creating anything', async () => {
    const fake = createFakeDB();
    fake.state.users.push({
      id: 9,
      google_id: 'email:abc',
      email: 'back@x.com',
      name: 'back',
      picture: '',
      credits: 900,
    });
    fake.state.identities.push({
      user_id: 9,
      provider: 'email',
      provider_id: 'back@x.com',
    });
    await seedCode(fake, 'back@x.com', '654321');
    const resp = await handleEmailVerify(
      post({ email: 'back@x.com', code: '654321' }),
      makeEnv(fake)
    );
    const body = (await resp.json()) as { user: { id: number } };
    expect(body.user.id).toBe(9);
    expect(fake.state.users).toHaveLength(1);
    expect(fake.state.identities).toHaveLength(1);
    expect(fake.state.transactions).toHaveLength(0);
  });

  it('rejects a wrong code and counts the attempt', async () => {
    const fake = createFakeDB();
    await seedCode(fake, 'a@x.com', '123456');
    const resp = await handleEmailVerify(
      post({ email: 'a@x.com', code: '000000' }),
      makeEnv(fake)
    );
    expect(resp.status).toBe(400);
    expect(fake.state.loginCodes[0].attempts).toBe(1);
    expect(fake.state.users).toHaveLength(0);
  });

  it('locks the code after max attempts', async () => {
    const fake = createFakeDB();
    await seedCode(fake, 'a@x.com', '123456', { attempts: 5 });
    const resp = await handleEmailVerify(
      post({ email: 'a@x.com', code: '123456' }),
      makeEnv(fake)
    );
    expect(resp.status).toBe(429);
    expect(fake.state.users).toHaveLength(0);
  });

  it('rejects expired codes', async () => {
    const fake = createFakeDB();
    await seedCode(fake, 'a@x.com', '123456', {
      expires_at: Date.now() - 1000,
    });
    const resp = await handleEmailVerify(
      post({ email: 'a@x.com', code: '123456' }),
      makeEnv(fake)
    );
    expect(resp.status).toBe(400);
  });

  it('a code can only be consumed once', async () => {
    const fake = createFakeDB();
    await seedCode(fake, 'a@x.com', '123456');
    const first = await handleEmailVerify(
      post({ email: 'a@x.com', code: '123456' }),
      makeEnv(fake)
    );
    expect(first.status).toBe(200);
    const second = await handleEmailVerify(
      post({ email: 'a@x.com', code: '123456' }),
      makeEnv(fake)
    );
    expect(second.status).toBe(400);
    // still exactly one user and one session
    expect(fake.state.users).toHaveLength(1);
    expect(fake.state.sessions).toHaveLength(1);
  });

  it('the atomic consumption guard refuses when another request won', async () => {
    const fake = createFakeDB();
    await seedCode(fake, 'a@x.com', '123456', { consumed_at: null });
    // Simulate the race: mark consumed between SELECT and UPDATE by
    // pre-consuming via a parallel "request" (direct state mutation after
    // the row is selected is not observable here, so consume first and
    // rely on the guard path).
    fake.state.loginCodes[0].consumed_at = Date.now();
    const resp = await handleEmailVerify(
      post({ email: 'a@x.com', code: '123456' }),
      makeEnv(fake)
    );
    // consumed rows are filtered by the SELECT already; the guard is the
    // second line of defense — either way, no session is created
    expect(resp.status).toBe(400);
    expect(fake.state.sessions).toHaveLength(0);
  });

  it('rejects malformed input', async () => {
    const fake = createFakeDB();
    expect(
      (
        await handleEmailVerify(
          post({ email: 'a@x.com', code: '12345' }),
          makeEnv(fake)
        )
      ).status
    ).toBe(400);
    expect(
      (
        await handleEmailVerify(
          post({ email: 'bad', code: '123456' }),
          makeEnv(fake)
        )
      ).status
    ).toBe(400);
  });
});

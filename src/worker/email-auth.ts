/**
 * Email OTP sign-in.
 *
 * Flow: POST /api/auth/email/start {email} sends a 6-digit code (Resend);
 * POST /api/auth/email/verify {email, code} exchanges it for a session.
 * Codes are stored hashed with a 10-minute TTL and at most 5 attempts.
 * Without RESEND_API_KEY the code is logged instead of emailed (dev/staging).
 */

import { Env } from './types';
import { createSession, createSessionCookie } from './auth';

// Lower than the Google welcome bonus: throwaway inboxes are cheap to farm.
export const EMAIL_SIGNUP_BONUS = 1000;

export const CODE_TTL_MINUTES = 10;
export const MAX_VERIFY_ATTEMPTS = 5;
// Issuance caps per normalized email address (durable, via login_codes rows)
const MAX_CODES_PER_15_MIN = 3;
const MAX_CODES_PER_DAY = 10;

/** Lowercased/trimmed address, or null if it doesn't look like an email. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

/**
 * Collapses +tags (and gmail dots) so signup farming with one inbox counts
 * as one address. Used for abuse accounting only — mail is still sent to,
 * and identity is still keyed by, the literal address.
 */
export function abuseKeyForEmail(email: string): string {
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at);
  const domain = email.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
  }
  return `${local}@${domain}`;
}

// A pragmatic blocklist of the most common disposable-email domains.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.info',
  '10minutemail.com',
  'temp-mail.org',
  'tempmail.com',
  'throwawaymail.com',
  'yopmail.com',
  'sharklasers.com',
  'trashmail.com',
  'getnada.com',
  'maildrop.cc',
  'dispostable.com',
  'fakeinbox.com',
  'tempinbox.com',
  'mail.tm',
  'mohmal.com',
  'linshiyouxiang.net',
  'zwoho.com',
  'chacuo.net',
]);

export function isDisposableEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return DISPOSABLE_DOMAINS.has(domain);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

export function generateLoginCode(): string {
  // 6 digits from a CSPRNG, uniform via rejection sampling.
  const range = 1_000_000;
  const limit = Math.floor(0xffffffff / range) * range;
  const buf = new Uint32Array(1);
  let v: number;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return String(v % range).padStart(6, '0');
}

function json(
  body: Record<string, unknown>,
  status = 200,
  headers?: Record<string, string>
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function sendCodeEmail(
  env: Env,
  email: string,
  code: string
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    // Dev/staging fallback: surfaced in Workers Logs instead of an inbox.
    console.log(`[email-auth] DEV login code for ${email}: ${code}`);
    return true;
  }
  // Paper-and-ink look matching the reader; inline styles only (email
  // clients strip everything else), text/plain fallback kept alongside.
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#f4f1ea;">
  <div style="max-width:440px;margin:0 auto;padding:40px 24px;font-family:Georgia,'Songti SC','Times New Roman',serif;">
    <div style="text-align:center;padding-bottom:20px;">
      <span style="font-size:26px;letter-spacing:0.08em;color:#2b241a;">Ovid</span>
      <div style="font-size:12px;color:#8a8171;letter-spacing:0.14em;padding-top:4px;">BILINGUAL READER</div>
    </div>
    <div style="background-color:#fffdf6;border:1px solid #e6dfcc;border-radius:12px;padding:32px 24px;text-align:center;">
      <div style="font-size:14px;color:#4a443a;">你的登录验证码 · Your sign-in code</div>
      <div style="font-size:36px;letter-spacing:0.28em;color:#2b241a;font-weight:bold;padding:18px 0 14px;font-family:'SF Mono',Menlo,Consolas,monospace;">${code}</div>
      <div style="font-size:12.5px;color:#8a8171;">${CODE_TTL_MINUTES} 分钟内有效 · Expires in ${CODE_TTL_MINUTES} minutes</div>
    </div>
    <div style="text-align:center;padding-top:20px;font-size:12px;color:#8a8171;line-height:1.7;">
      如果这不是你本人的操作,请忽略这封邮件。<br/>
      If you didn't request this, you can safely ignore this email.
    </div>
  </div>
</body>
</html>`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Ovid <login@ovid.ink>',
      to: [email],
      subject: `${code} — Ovid 登录验证码 / your sign-in code`,
      text: `你的 Ovid 登录验证码是:${code}\n10 分钟内有效。如果这不是你本人的操作,请忽略这封邮件。\n\nYour Ovid sign-in code is: ${code}\nIt expires in ${CODE_TTL_MINUTES} minutes. If you didn't request this, you can safely ignore this email.`,
      html,
    }),
  });
  if (!resp.ok) {
    console.error('[email-auth] Resend error:', resp.status, await resp.text());
    return false;
  }
  return true;
}

export async function handleEmailStart(
  request: Request,
  env: Env
): Promise<Response> {
  let body: { email?: unknown };
  try {
    body = (await request.json()) as { email?: unknown };
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  const email = normalizeEmail(body.email);
  if (!email) {
    return json({ error: 'Invalid email address' }, 400);
  }
  if (isDisposableEmail(email)) {
    return json({ error: 'Temporary email addresses are not supported' }, 400);
  }

  // Durable issuance caps, counted against the abuse key so +tags and
  // gmail-dot variants share a budget.
  const abuseKey = abuseKeyForEmail(email);
  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN created_at >= datetime('now', '-15 minutes') THEN 1 ELSE 0 END) AS recent,
       SUM(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS daily
     FROM login_codes WHERE abuse_key = ?`
  )
    .bind(abuseKey)
    .first<{ recent: number | null; daily: number | null }>();
  if (
    (counts?.recent ?? 0) >= MAX_CODES_PER_15_MIN ||
    (counts?.daily ?? 0) >= MAX_CODES_PER_DAY
  ) {
    return json({ error: 'Too many codes requested — try again later' }, 429);
  }

  const code = generateLoginCode();
  const codeHash = await sha256Hex(`${email}:${code}`);
  await env.DB.prepare(
    `INSERT INTO login_codes (email, abuse_key, code_hash, expires_at)
     VALUES (?, ?, ?, datetime('now', '+${CODE_TTL_MINUTES} minutes'))`
  )
    .bind(email, abuseKey, codeHash)
    .run();

  const sent = await sendCodeEmail(env, email, code);
  if (!sent) {
    return json({ error: 'Failed to send the code — try again later' }, 502);
  }
  // Same response whether or not the address has an account.
  return json({ ok: true });
}

export async function handleEmailVerify(
  request: Request,
  env: Env
): Promise<Response> {
  let body: { email?: unknown; code?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; code?: unknown };
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  const email = normalizeEmail(body.email);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!email || !/^\d{6}$/.test(code)) {
    return json({ error: 'Invalid code' }, 400);
  }

  const row = await env.DB.prepare(
    `SELECT id, code_hash, attempts FROM login_codes
     WHERE email = ? AND consumed_at IS NULL AND expires_at > datetime('now')
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(email)
    .first<{ id: number; code_hash: string; attempts: number }>();
  if (!row) {
    return json(
      { error: 'Code expired or not found — request a new one' },
      400
    );
  }
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    return json({ error: 'Too many attempts — request a new code' }, 429);
  }
  await env.DB.prepare(
    'UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?'
  )
    .bind(row.id)
    .run();

  const expected = await sha256Hex(`${email}:${code}`);
  if (expected !== row.code_hash) {
    return json({ error: 'Incorrect code' }, 400);
  }
  await env.DB.prepare(
    `UPDATE login_codes SET consumed_at = datetime('now') WHERE id = ?`
  )
    .bind(row.id)
    .run();

  // Resolve the account: email identity → any user with this (verified)
  // email (e.g. an existing Google account) → create a fresh user.
  let userId: number | null = null;
  const identity = await env.DB.prepare(
    `SELECT user_id FROM user_identities WHERE provider = 'email' AND provider_id = ?`
  )
    .bind(email)
    .first<{ user_id: number }>();
  if (identity) {
    userId = identity.user_id;
  } else {
    const existing = await env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    )
      .bind(email)
      .first<{ id: number }>();
    if (existing) {
      userId = existing.id;
    } else {
      // users.google_id is NOT NULL UNIQUE for legacy reasons — email-born
      // accounts get a sentinel; user_identities is the source of truth.
      const sentinel = `email:${crypto.randomUUID()}`;
      const displayName = email.slice(0, email.indexOf('@'));
      await env.DB.prepare(
        'INSERT INTO users (google_id, email, name, picture, credits) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(sentinel, email, displayName, '', EMAIL_SIGNUP_BONUS)
        .run();
      const created = await env.DB.prepare(
        'SELECT id FROM users WHERE google_id = ?'
      )
        .bind(sentinel)
        .first<{ id: number }>();
      userId = created!.id;
      await env.DB.prepare(
        `INSERT INTO credit_transactions (user_id, amount, type, description, balance_after)
         VALUES (?, ?, 'signup_bonus', 'Welcome bonus credits (email signup)', ?)`
      )
        .bind(userId, EMAIL_SIGNUP_BONUS, EMAIL_SIGNUP_BONUS)
        .run();
    }
    await env.DB.prepare(
      `INSERT OR IGNORE INTO user_identities (user_id, provider, provider_id) VALUES (?, 'email', ?)`
    )
      .bind(userId, email)
      .run();
  }

  const sessionToken = await createSession(env.DB, userId!);
  const user = await env.DB.prepare(
    'SELECT id, email, name, picture FROM users WHERE id = ?'
  )
    .bind(userId)
    .first();
  return json({ user }, 200, {
    'Set-Cookie': createSessionCookie(sessionToken),
  });
}

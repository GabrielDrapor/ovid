/**
 * Authentication helper functions
 */

import { Env, User } from './types';

// Welcome bonus credits for new users
export const WELCOME_BONUS_CREDITS = 5000;

export function generateSessionToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function getSessionCookie(request: Request): string | null {
  const cookies = request.headers.get('Cookie') || '';
  const match = cookies.match(/ovid_session=([^;]+)/);
  return match ? match[1] : null;
}

export function createSessionCookie(
  token: string,
  maxAge: number = 30 * 24 * 60 * 60
): string {
  return `ovid_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function createExpiredSessionCookie(): string {
  return 'ovid_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

export async function getCurrentUser(
  db: D1Database,
  request: Request
): Promise<User | null> {
  const sessionToken = getSessionCookie(request);
  if (!sessionToken) return null;

  const session = await db
    .prepare(
      `SELECT s.*, u.id as user_id, u.email, u.name, u.picture
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.session_token = ? AND s.expires_at > datetime('now')`
    )
    .bind(sessionToken)
    .first();

  if (!session) return null;

  return {
    id: session.user_id as number,
    email: session.email as string,
    name: session.name as string,
    picture: session.picture as string,
  };
}

export async function handleGoogleAuthStart(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/auth/callback/google`;
  const scope = 'openid email profile';
  const state = generateSessionToken();

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_OAUTH_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

export async function handleGoogleCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(`OAuth error: ${error}`, { status: 400 });
  }

  if (!code) {
    return new Response('Missing authorization code', { status: 400 });
  }

  // Exchange code for tokens
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${new URL(request.url).origin}/api/auth/callback/google`,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error('Token exchange failed:', errorText);
    return new Response('Failed to exchange authorization code', { status: 500 });
  }

  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    id_token: string;
  };

  // Get user info from Google
  const userInfoResponse = await fetch(
    'https://www.googleapis.com/oauth2/v2/userinfo',
    { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  );

  if (!userInfoResponse.ok) {
    return new Response('Failed to get user info', { status: 500 });
  }

  const googleUser = (await userInfoResponse.json()) as {
    id: string;
    email: string;
    name: string;
    picture: string;
  };

  // Create or update user in database
  let user = await env.DB.prepare('SELECT * FROM users WHERE google_id = ?')
    .bind(googleUser.id)
    .first();

  if (user) {
    await env.DB.prepare(
      `UPDATE users SET email = ?, name = ?, picture = ?, updated_at = datetime('now') WHERE google_id = ?`
    )
      .bind(googleUser.email, googleUser.name, googleUser.picture, googleUser.id)
      .run();
  } else {
    await env.DB.prepare(
      'INSERT INTO users (google_id, email, name, picture, credits) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(googleUser.id, googleUser.email, googleUser.name, googleUser.picture, WELCOME_BONUS_CREDITS)
      .run();
    user = await env.DB.prepare('SELECT * FROM users WHERE google_id = ?')
      .bind(googleUser.id)
      .first();

    // Record signup bonus transaction
    if (user) {
      await env.DB.prepare(
        `INSERT INTO credit_transactions (user_id, amount, type, description, balance_after)
         VALUES (?, ?, 'signup_bonus', 'Welcome bonus credits', ?)`
      )
        .bind(user.id, WELCOME_BONUS_CREDITS, WELCOME_BONUS_CREDITS)
        .run();
    }
  }

  // Create session
  const sessionToken = generateSessionToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await env.DB.prepare(
    'INSERT INTO sessions (user_id, session_token, expires_at) VALUES (?, ?, ?)'
  )
    .bind(user!.id, sessionToken, expiresAt.toISOString())
    .run();

  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL(request.url).origin,
      'Set-Cookie': createSessionCookie(sessionToken),
    },
  });
}

export async function handleGetCurrentUser(
  request: Request,
  env: Env
): Promise<Response> {
  const user = await getCurrentUser(env.DB, request);

  if (!user) {
    return new Response(JSON.stringify({ user: null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const sessionToken = getSessionCookie(request);

  if (sessionToken) {
    await env.DB.prepare('DELETE FROM sessions WHERE session_token = ?')
      .bind(sessionToken)
      .run();
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': createExpiredSessionCookie(),
    },
  });
}

// Config check helpers
let oauthWarningLogged = false;

export function checkOAuthConfig(env: Env): { configured: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!env.GOOGLE_OAUTH_CLIENT_ID) errors.push('GOOGLE_OAUTH_CLIENT_ID');
  if (!env.GOOGLE_OAUTH_CLIENT_SECRET) errors.push('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!env.APP_URL) errors.push('APP_URL');

  const configured = errors.length === 0;

  if (!configured && !oauthWarningLogged) {
    console.warn(
      `[OAuth Warning] Missing: ${errors.join(', ')}. Google OAuth login will not work.`
    );
    oauthWarningLogged = true;
  }

  return { configured, errors };
}

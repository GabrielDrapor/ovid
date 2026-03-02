/**
 * Credits and Stripe payment functions
 */

import { Env, User } from './types';
import { getCurrentUser } from './auth';

// Credit packages available for purchase
export const CREDIT_PACKAGES = [
  { id: 'credits_1000', credits: 1000, price: 500, currency: 'usd', name: '1,000 Credits' },
  { id: 'credits_5000', credits: 5000, price: 2000, currency: 'usd', name: '5,000 Credits' },
  { id: 'credits_15000', credits: 15000, price: 5000, currency: 'usd', name: '15,000 Credits' },
];

export async function getUserCredits(db: D1Database, userId: number): Promise<number> {
  const user = await db
    .prepare('SELECT credits FROM users WHERE id = ?')
    .bind(userId)
    .first();
  return (user?.credits as number) || 0;
}

export async function deductCredits(
  db: D1Database,
  userId: number,
  amount: number,
  bookUuid: string,
  description: string
): Promise<boolean> {
  const currentCredits = await getUserCredits(db, userId);
  if (currentCredits < amount) {
    return false;
  }

  const newBalance = currentCredits - amount;

  await db
    .prepare('UPDATE users SET credits = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind(newBalance, userId)
    .run();

  await db
    .prepare(
      `INSERT INTO credit_transactions (user_id, amount, type, description, book_uuid, balance_after)
       VALUES (?, ?, 'usage', ?, ?, ?)`
    )
    .bind(userId, -amount, description, bookUuid, newBalance)
    .run();

  return true;
}

export async function addCredits(
  db: D1Database,
  userId: number,
  amount: number,
  type: 'signup_bonus' | 'purchase' | 'refund',
  description: string,
  stripePaymentIntentId?: string
): Promise<number> {
  // Atomic increment to avoid read-then-write race conditions
  await db
    .prepare('UPDATE users SET credits = credits + ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind(amount, userId)
    .run();

  const newBalance = await getUserCredits(db, userId);

  await db
    .prepare(
      `INSERT INTO credit_transactions (user_id, amount, type, description, stripe_payment_intent_id, balance_after)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, amount, type, description, stripePaymentIntentId || null, newBalance)
    .run();

  return newBalance;
}

// Stripe API helper
async function stripeRequest(
  env: Env,
  endpoint: string,
  method: 'GET' | 'POST' = 'POST',
  body?: Record<string, string>
): Promise<any> {
  const url = `https://api.stripe.com/v1${endpoint}`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  const options: RequestInit = { method, headers };

  if (body && method === 'POST') {
    options.body = new URLSearchParams(body).toString();
  }

  const response = await fetch(url, options);
  return response.json();
}

async function verifyStripeWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1];
  const v1Signature = parts.find(p => p.startsWith('v1='))?.split('=')[1];

  if (!timestamp || !v1Signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return expectedSignature === v1Signature;
}

export async function handleGetCredits(
  request: Request,
  env: Env
): Promise<Response> {
  const user = await getCurrentUser(env.DB, request);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const credits = await getUserCredits(env.DB, user.id);

  return new Response(
    JSON.stringify({ credits, packages: CREDIT_PACKAGES }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

export async function handleGetCreditTransactions(
  request: Request,
  env: Env
): Promise<Response> {
  const user = await getCurrentUser(env.DB, request);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const transactions = await env.DB
    .prepare(
      `SELECT id, amount, type, description, book_uuid, balance_after, created_at
       FROM credit_transactions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .bind(user.id)
    .all();

  return new Response(JSON.stringify({ transactions: transactions.results }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleCreateCheckoutSession(
  request: Request,
  env: Env
): Promise<Response> {
  const user = await getCurrentUser(env.DB, request);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json() as { packageId: string };
    const creditPackage = CREDIT_PACKAGES.find(p => p.id === body.packageId);

    if (!creditPackage) {
      return new Response(JSON.stringify({ error: 'Invalid package' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const session = await stripeRequest(env, '/checkout/sessions', 'POST', {
      'mode': 'payment',
      'success_url': `${new URL(request.url).origin}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url': `${new URL(request.url).origin}?payment=cancelled`,
      'line_items[0][price_data][currency]': creditPackage.currency,
      'line_items[0][price_data][product_data][name]': creditPackage.name,
      'line_items[0][price_data][product_data][description]': `${creditPackage.credits} credits for book translations`,
      'line_items[0][price_data][unit_amount]': creditPackage.price.toString(),
      'line_items[0][quantity]': '1',
      'metadata[user_id]': user.id.toString(),
      'metadata[package_id]': body.packageId,
      'metadata[credits]': creditPackage.credits.toString(),
      'client_reference_id': user.id.toString(),
    });

    if (session.error) {
      console.error('Stripe error:', session.error);
      return new Response(JSON.stringify({ error: 'Failed to create checkout session' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ url: session.url, sessionId: session.id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Checkout session error:', error);
    return new Response(JSON.stringify({ error: 'Failed to create checkout session' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function handleStripeWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing signature', { status: 400 });
  }

  const payload = await request.text();
  const isValid = await verifyStripeWebhookSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);

  if (!isValid) {
    console.error('Invalid webhook signature');
    return new Response('Invalid signature', { status: 400 });
  }

  let event: {
    type: string;
    data: {
      object: {
        id: string;
        payment_intent: string;
        metadata: { user_id: string; package_id: string; credits: string };
      };
    };
  };

  try {
    event = JSON.parse(payload);
  } catch (parseError) {
    // Non-recoverable: bad payload, return 200 so Stripe doesn't retry
    console.error('Webhook JSON parse error:', parseError);
    return new Response(JSON.stringify({ received: true, error: 'Invalid JSON' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = parseInt(session.metadata.user_id);
      const credits = parseInt(session.metadata.credits);
      const packageId = session.metadata.package_id;

      if (!userId || !credits) {
        // Non-recoverable: bad metadata, return 200
        console.error('Webhook missing metadata:', session.metadata);
        return new Response(JSON.stringify({ received: true, error: 'Invalid metadata' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const existing = await env.DB
        .prepare('SELECT id FROM credit_transactions WHERE stripe_payment_intent_id = ?')
        .bind(session.payment_intent)
        .first();

      if (!existing) {
        const creditPackage = CREDIT_PACKAGES.find(p => p.id === packageId);
        await addCredits(
          env.DB,
          userId,
          credits,
          'purchase',
          `Purchased ${creditPackage?.name || credits + ' credits'}`,
          session.payment_intent
        );
        console.log(`Added ${credits} credits to user ${userId}`);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    // Recoverable (likely DB error): return 500 so Stripe retries
    console.error('Webhook processing error:', error);
    return new Response('Webhook processing failed', { status: 500 });
  }
}

export async function handleVerifyCheckoutSession(
  request: Request,
  env: Env
): Promise<Response> {
  const user = await getCurrentUser(env.DB, request);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');

  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Missing session_id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const session = await stripeRequest(env, `/checkout/sessions/${sessionId}`, 'GET');

    if (session.error) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (session.metadata?.user_id !== user.id.toString()) {
      return new Response(JSON.stringify({ error: 'Session does not belong to user' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (session.payment_status !== 'paid') {
      return new Response(JSON.stringify({
        success: false,
        status: session.payment_status,
        message: 'Payment not completed'
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const existingTransaction = await env.DB
      .prepare('SELECT id FROM credit_transactions WHERE stripe_payment_intent_id = ?')
      .bind(session.payment_intent)
      .first();

    if (existingTransaction) {
      const credits = await getUserCredits(env.DB, user.id);
      return new Response(JSON.stringify({
        success: true,
        alreadyProcessed: true,
        credits
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const creditsToAdd = parseInt(session.metadata.credits);
    const packageId = session.metadata.package_id;
    const creditPackage = CREDIT_PACKAGES.find(p => p.id === packageId);

    await addCredits(
      env.DB,
      user.id,
      creditsToAdd,
      'purchase',
      `Purchased ${creditPackage?.name || creditsToAdd + ' credits'}`,
      session.payment_intent
    );

    const newCredits = await getUserCredits(env.DB, user.id);

    return new Response(JSON.stringify({
      success: true,
      creditsAdded: creditsToAdd,
      credits: newCredits
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Verify session error:', error);
    return new Response(JSON.stringify({ error: 'Failed to verify session' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Config check helper
let stripeWarningLogged = false;

export function checkStripeConfig(env: Env, requireWebhook = false): { configured: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!env.STRIPE_SECRET_KEY) errors.push('STRIPE_SECRET_KEY');
  if (requireWebhook && !env.STRIPE_WEBHOOK_SECRET) errors.push('STRIPE_WEBHOOK_SECRET');
  if (!env.STRIPE_PUBLISHABLE_KEY) errors.push('STRIPE_PUBLISHABLE_KEY');

  const configured = errors.length === 0;

  if (!configured && !stripeWarningLogged) {
    console.warn(`[Stripe Warning] Missing: ${errors.join(', ')}. Stripe payments will not work.`);
    stripeWarningLogged = true;
  }

  return { configured, errors };
}

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { UserProvider, useUser } from '../../../src/contexts/UserContext';

const reply = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );

function mockApi(verify: () => Promise<Response>) {
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/stripe/verify-session')) return verify();
    if (url === '/api/auth/me') return reply({ user: { id: 1 } });
    if (url === '/api/credits') return reply({ credits: 100, packages: [] });
    return reply({});
  }) as any;
}

function Notice() {
  const { paymentNotice } = useUser();
  return <div data-testid="notice">{JSON.stringify(paymentNotice)}</div>;
}

const notice = () => JSON.parse(screen.getByTestId('notice').textContent!);

afterEach(() => window.history.replaceState({}, '', '/'));

describe('payment notice after Stripe', () => {
  it('reports the credits that were added', async () => {
    window.history.replaceState({}, '', '/?payment=success&session_id=cs_1');
    mockApi(() =>
      reply({ success: true, creditsAdded: 50000, credits: 50100 })
    );
    render(
      <UserProvider>
        <Notice />
      </UserProvider>
    );
    await waitFor(() =>
      expect(notice()).toEqual({ kind: 'added', creditsAdded: 50000 })
    );
    expect(window.location.search).toBe('');
  });

  it('says the payment is pending when it is not confirmed yet', async () => {
    window.history.replaceState({}, '', '/?payment=success&session_id=cs_2');
    mockApi(() => reply({ success: false, status: 'unpaid' }));
    render(
      <UserProvider>
        <Notice />
      </UserProvider>
    );
    await waitFor(() => expect(notice()).toEqual({ kind: 'pending' }));
  });

  it('notes a cancelled checkout', async () => {
    window.history.replaceState({}, '', '/?payment=cancelled');
    mockApi(() => reply({}));
    render(
      <UserProvider>
        <Notice />
      </UserProvider>
    );
    await waitFor(() => expect(notice()).toEqual({ kind: 'cancelled' }));
  });
});

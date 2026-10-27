import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('../../../src/components/BookShelf.css', () => ({}));

// What useUser returns; tests change the purchase and the payment notice.
const userState = vi.hoisted(() => ({
  user: { id: 1, email: 'test@test.com', name: 'Test', picture: '' },
  purchaseCredits: (() => Promise.resolve()) as (id: string) => Promise<void>,
  paymentNotice: null as null | { kind: string; creditsAdded?: number },
  clearPaymentNotice: () => {},
}));
vi.mock('../../../src/contexts/UserContext', () => ({
  useUser: () => ({
    user: userState.user,
    loading: false,
    login: () => {},
    logout: () => {},
    credits: 100,
    creditPackages: [
      { id: 'small', credits: 1000, price: 500, currency: 'usd', name: 'S' },
      { id: 'large', credits: 50000, price: 2000, currency: 'usd', name: 'L' },
    ],
    purchaseCredits: userState.purchaseCredits,
    refreshCredits: () => Promise.resolve(),
    paymentNotice: userState.paymentNotice,
    clearPaymentNotice: userState.clearPaymentNotice,
  }),
}));

// The 3D closet's empty bay is the way into the upload form.
vi.mock('../../../src/components/shelf3d/BookShelf3D', () => ({
  default: ({ onUploadToSlot }: any) => (
    <button onClick={() => onUploadToSlot?.({ row: 0, col: 1 })}>
      empty bay
    </button>
  ),
}));
(window as any).WebGLRenderingContext = function () {};
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as any;

import BookShelf from '../../../src/components/BookShelf';

const PENDING_UPLOAD_KEY = 'ovid_pending_upload';
// 1,450 needed, 100 available: 1,350 short.
const ESTIMATE = {
  title: 'Dorian Gray',
  author: 'Oscar Wilde',
  chapters: 20,
  characters: 430000,
  estimatedTokens: 150000,
  requiredCredits: 1450,
  availableCredits: 100,
  canAfford: false,
  fileKey: 'uploads/_estimate/abc.epub',
  detectedSourceLanguage: 'en',
};

const reply = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );

let estimateReply: () => Promise<Response>;
global.fetch = vi.fn((input: RequestInfo | URL) => {
  const url = String(input);
  if (url === '/api/books/estimate') return estimateReply();
  if (url === '/api/v2/books') return reply([]);
  return reply({});
}) as any;

async function openCatalogueForm() {
  render(<BookShelf onSelectBook={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'empty bay' }));
  const form = screen.getByRole('dialog', { name: 'Add book here' });
  fireEvent.drop(form, {
    dataTransfer: { files: [new File(['x'], 'dorian.epub')] },
  });
  await screen.findByText('Dorian Gray');
}

const openBuyDialog = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Buy credits' }));
  return screen.getByRole('dialog', { name: 'Buy credits' });
};

beforeEach(() => {
  sessionStorage.clear();
  estimateReply = () => reply(ESTIMATE);
  userState.purchaseCredits = () => new Promise(() => {});
  userState.paymentNotice = null;
  userState.clearPaymentNotice = vi.fn();
});

describe('buying credits from the upload form', () => {
  it('opens on top of the form and says how many credits are missing', async () => {
    await openCatalogueForm();
    const buy = openBuyDialog();

    expect(buy).toHaveTextContent('This book needs 1,350 more credits');
    // The 1,000 package wouldn't cover it.
    expect(within(buy).getByRole('button', { name: /^1,000/ })).toHaveClass(
      'credit-package--short'
    );
    expect(
      within(buy).getByRole('button', { name: /^50,000/ })
    ).not.toHaveClass('credit-package--short');
    // The upload form is still there underneath.
    expect(screen.getByText('Dorian Gray')).toBeInTheDocument();
  });

  it('closes only the top dialog on Escape', async () => {
    await openCatalogueForm();
    openBuyDialog();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: 'Buy credits' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('Dorian Gray')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Dorian Gray')).not.toBeInTheDocument();
  });

  it('shows the package as busy and keeps the upload for after paying', async () => {
    await openCatalogueForm();
    const buy = openBuyDialog();
    const large = within(buy).getByRole('button', { name: /^50,000/ });

    fireEvent.click(large);
    expect(large).toHaveAttribute('aria-busy', 'true');
    expect(within(buy).getByRole('button', { name: /^1,000/ })).toBeDisabled();
    const saved = JSON.parse(sessionStorage.getItem(PENDING_UPLOAD_KEY)!);
    expect(saved).toMatchObject({
      fileKey: ESTIMATE.fileKey,
      targetLanguage: 'zh',
      sourceLanguage: 'en',
    });
  });

  it('reports a checkout that fails and lets the user try again', async () => {
    userState.purchaseCredits = () => Promise.reject(new Error('Stripe down'));
    await openCatalogueForm();
    const buy = openBuyDialog();

    await act(async () =>
      fireEvent.click(within(buy).getByRole('button', { name: /^50,000/ }))
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't open the payment page"
    );
    expect(
      within(buy).getByRole('button', { name: /^50,000/ })
    ).not.toBeDisabled();
    expect(sessionStorage.getItem(PENDING_UPLOAD_KEY)).toBeNull();
  });
});

describe('coming back from Stripe', () => {
  const savePending = () =>
    sessionStorage.setItem(
      PENDING_UPLOAD_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        fileKey: ESTIMATE.fileKey,
        targetLanguage: 'ja',
        sourceLanguage: 'en',
        uploadTarget: { row: 0, col: 1 },
      })
    );

  it('says the credits arrived and reopens the upload where it was', async () => {
    savePending();
    estimateReply = () =>
      reply({ ...ESTIMATE, availableCredits: 50100, canAfford: true });
    userState.paymentNotice = { kind: 'added', creditsAdded: 50000 };
    render(<BookShelf onSelectBook={vi.fn()} />);

    expect(await screen.findByText('Dorian Gray')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      '50,000 credits added'
    );
    expect(
      (
        screen.getByRole('combobox', {
          name: 'Target language',
        }) as HTMLSelectElement
      ).value
    ).toBe('ja');
    expect(
      screen.getByRole('button', { name: 'Confirm & translate' })
    ).toBeEnabled();
    expect(userState.clearPaymentNotice).toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_UPLOAD_KEY)).toBeNull();
  });

  it('asks for the file again when the stored copy is gone', async () => {
    savePending();
    estimateReply = () =>
      reply({ error: 'Estimated file not found — please re-upload' }, 404);
    userState.paymentNotice = { kind: 'cancelled' };
    render(<BookShelf onSelectBook={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please choose the book again'
    );
    // Back on the first form, ready for the file.
    expect(screen.getByText('drop or pick a book')).toBeInTheDocument();
  });
});

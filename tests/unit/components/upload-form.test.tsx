import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('../../../src/components/BookShelf.css', () => ({}));

// A stable user object: BookShelf refetches whenever `user` changes.
vi.mock('../../../src/contexts/UserContext', () => {
  const user = { id: 1, email: 'test@test.com', name: 'Test', picture: '' };
  return {
    useUser: () => ({
      user,
      loading: false,
      login: vi.fn(),
      logout: vi.fn(),
      credits: 5000,
      creditPackages: [],
      purchaseCredits: vi.fn(),
      refreshCredits: vi.fn(),
    }),
  };
});

// The 3D closet is the only way into the upload form; this stand-in offers
// one empty, unlabeled bay (third bay of the second row).
vi.mock('../../../src/components/shelf3d/BookShelf3D', () => ({
  default: ({ onUploadToSlot }: any) => (
    <button
      onClick={() =>
        onUploadToSlot?.({ row: 0, col: 1, position: { row: 2, col: 3 } })
      }
    >
      empty bay
    </button>
  ),
}));

// Pretend WebGL works so BookShelf renders the closet instead of the 2D wall.
(window as any).WebGLRenderingContext = function () {};
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as any;

import BookShelf from '../../../src/components/BookShelf';

const ESTIMATE = {
  title: 'Dorian Gray',
  author: 'Oscar Wilde',
  chapters: 20,
  characters: 430000,
  estimatedTokens: 150000,
  requiredCredits: 1450,
  availableCredits: 5000,
  canAfford: true,
  fileKey: 'key-1',
  detectedSourceLanguage: 'en',
};

const reply = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );

type Handler = (init?: RequestInit) => Promise<Response>;
let estimateHandler: Handler;
const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === '/api/books/estimate') return estimateHandler(init);
  if (url === '/api/v2/books') return reply([]);
  return reply({});
});
global.fetch = fetchMock as any;

/** A request that only settles when its signal aborts. */
const hanging: Handler = (init) =>
  new Promise((_, reject) =>
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError'))
    )
  );

const book = (name: string) => new File(['x'], name);

async function openForm() {
  render(<BookShelf onSelectBook={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'empty bay' }));
  return screen.getByRole('dialog', { name: 'Add book here' });
}

function drop(target: HTMLElement, file: File) {
  fireEvent.drop(target, { dataTransfer: { files: [file], types: ['Files'] } });
}

const estimateCalls = () =>
  fetchMock.mock.calls.filter(([url]) => url === '/api/books/estimate');

beforeEach(() => {
  fetchMock.mockClear();
  estimateHandler = () => reply(ESTIMATE);
});

describe('upload form', () => {
  it('names an unlabeled bay by where it is on the wall', async () => {
    const form = await openForm();
    expect(form).toHaveTextContent('Row 2, bay 3');
    expect(form).toHaveTextContent('epub · mobi · azw3');
  });

  it('takes a book dropped on the form', async () => {
    const form = await openForm();
    drop(form, book('dorian.epub'));
    expect(await screen.findByText('Dorian Gray')).toBeInTheDocument();
    expect(estimateCalls()).toHaveLength(1);
  });

  it('turns away a dropped file of another type', async () => {
    const form = await openForm();
    drop(form, book('notes.pdf'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only EPUB, MOBI and AZW3 files can be uploaded'
    );
    expect(estimateCalls()).toHaveLength(0);
  });

  it('can be cancelled while the book is being analyzed', async () => {
    estimateHandler = hanging;
    const form = await openForm();
    drop(form, book('slow.epub'));
    expect(await screen.findByText('analyzing book…')).toBeInTheDocument();

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const signal = estimateCalls()[0][1]!.signal!;
    expect(signal.aborted).toBe(true);
    // Nothing to report: cancelling isn't a failure.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the same height while analyzing', async () => {
    estimateHandler = hanging;
    const form = await openForm();
    const rowsBefore = form.querySelectorAll('.uf-row').length;
    drop(form, book('slow.epub'));
    await screen.findByText('analyzing book…');
    // Same rows around a status block the size of the drop box.
    expect(form.querySelectorAll('.uf-row')).toHaveLength(rowsBefore);
    expect(form.querySelector('.uf-affix-status')).toBeInTheDocument();
  });

  it('shows a new target language at once and restores it if the estimate fails', async () => {
    const form = await openForm();
    drop(form, book('dorian.epub'));
    const target = (await screen.findByRole('combobox', {
      name: 'Target language',
    })) as HTMLSelectElement;
    expect(target.value).toBe('zh');

    let fail!: () => void;
    estimateHandler = () =>
      new Promise((resolve) => {
        fail = () => resolve(new Response('{"error":"busy"}', { status: 503 }));
      });
    fireEvent.change(target, { target: { value: 'ja' } });
    expect(target.value).toBe('ja');

    await act(async () => fail());
    await waitFor(() => expect(target.value).toBe('zh'));
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't update the estimate"
    );
  });

  it('closes from the catalogue form with Cancel', async () => {
    const form = await openForm();
    drop(form, book('dorian.epub'));
    await screen.findByText('Dorian Gray');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

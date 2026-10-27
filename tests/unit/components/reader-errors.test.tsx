import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// fetchWithRetry backs off for seconds between attempts; one try is enough.
vi.mock('../../../src/utils/fetchWithRetry', () => ({
  fetchWithRetry: (input: RequestInfo, init?: RequestInit) =>
    fetch(input, init),
}));

let mockUser: { id: number; email: string; name: string } | null = null;
vi.mock('../../../src/contexts/UserContext', () => ({
  useUser: () => ({ user: mockUser, loading: false }),
}));

class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.IntersectionObserver = MockIntersectionObserver as any;

import AppV2 from '../../../src/AppV2';
import SharedBookView from '../../../src/components/SharedBookView';

const BOOK = 'book-1';
const CHAPTER = {
  uuid: BOOK,
  title: 'Test Book',
  originalTitle: 'Test Book',
  author: 'Author',
  styles: '',
  currentChapter: 1,
  chapterInfo: { number: 1, title: 'One', originalTitle: 'One' },
  rawHtml: '<body><p>Hello world</p></body>',
  translations: [
    {
      xpath: '/body[1]/p[1]',
      original_text: 'Hello world',
      translated_text: '你好世界',
    },
  ],
};
const CHAPTERS = [
  { id: 1, chapter_number: 1, title: 'One', original_title: 'One' },
];

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Answer each request from the first route whose key the URL contains. */
function mockApi(routes: Record<string, () => Response>) {
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    return Promise.resolve(key ? routes[key]() : reply({}));
  }) as any;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ovid_onboarding_seen', '1');
  mockUser = null;
});

describe('reader error pages', () => {
  it('says the book was not found instead of leaving for the shelf', async () => {
    mockApi({
      '/chapters': () => reply({ error: 'Not found' }, 404),
      '/chapter/': () => reply({ error: 'Not found' }, 404),
      '/progress': () => reply({ error: 'Unauthorized' }, 401),
    });
    const onBackToShelf = vi.fn();
    render(<AppV2 bookUuid={BOOK} onBackToShelf={onBackToShelf} />);

    expect(await screen.findByText('Book not found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to shelf' }));
    expect(onBackToShelf).toHaveBeenCalled();
  });

  it('retries a chapter that failed to load', async () => {
    let failures = 1;
    mockApi({
      '/chapters': () => reply(CHAPTERS),
      '/chapter/1': () =>
        failures-- > 0 ? reply({ error: 'boom' }, 500) : reply(CHAPTER),
      '/progress': () => reply({ error: 'Unauthorized' }, 401),
    });
    render(<AppV2 bookUuid={BOOK} onBackToShelf={vi.fn()} />);

    expect(
      await screen.findByText("Couldn't load this chapter")
    ).toBeInTheDocument();
    expect(screen.getByText('HTTP error! status: 500')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Hello world')).toBeInTheDocument();
  });

  it('offers Mark as read only when signed in', async () => {
    mockApi({
      '/chapters': () => reply(CHAPTERS),
      '/chapter/1': () => reply(CHAPTER),
      '/progress': () => reply({ progress: null }),
    });
    const { unmount } = render(
      <AppV2 bookUuid={BOOK} onBackToShelf={vi.fn()} />
    );
    await screen.findByText('Hello world');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(
      screen.queryByRole('switch', { name: 'Mark as read' })
    ).not.toBeInTheDocument();
    unmount();

    mockUser = { id: 1, email: 'a@b.c', name: 'A' };
    render(<AppV2 bookUuid={BOOK} onBackToShelf={vi.fn()} />);
    await screen.findByText('Hello world');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(
      screen.getByRole('switch', { name: 'Mark as read' })
    ).toBeInTheDocument();
  });
});

describe('shared link error pages', () => {
  it('says the link no longer works, even when the chapter fails too', async () => {
    mockApi({
      '/chapters': () => reply({ error: 'Not found' }, 404),
      '/chapter/': () => reply({ error: 'Not found' }, 404),
    });
    render(<SharedBookView shareToken="tok" />);

    expect(
      await screen.findByText('This link no longer works')
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText("Couldn't load this chapter")
      ).not.toBeInTheDocument()
    );
    expect(screen.getByRole('link', { name: 'Go to library' })).toHaveAttribute(
      'href',
      '/'
    );
  });
});

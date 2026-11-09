import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

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

let saveStatus = 200;
const saves = () =>
  (global.fetch as any).mock.calls.filter(
    ([url, init]: [string, RequestInit?]) =>
      String(url).endsWith('/progress') && init?.method === 'PUT'
  );

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ovid_onboarding_seen', '1');
  saveStatus = 200;
  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/progress')) {
      return Promise.resolve(
        init?.method === 'PUT'
          ? reply({ error: 'x' }, saveStatus)
          : reply({ progress: null })
      );
    }
    if (url.includes('/chapters')) return Promise.resolve(reply(CHAPTERS));
    if (url.includes('/chapter/')) return Promise.resolve(reply(CHAPTER));
    return Promise.resolve(reply({}));
  }) as any;
});

afterAll(() => new Promise((resolve) => setTimeout(resolve, 150)));

/** Flip the whole book to the other language from the menu: saves at once. */
async function flipLanguage() {
  await screen.findByText('Hello world');
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
  fireEvent.click(
    await screen.findByRole('button', { name: /^Show (original|translation)$/ })
  );
}

describe('reader progress sync', () => {
  it('tells a signed-in reader once when the session ran out', async () => {
    mockUser = { id: 1, email: 'a@b.c', name: 'A' };
    saveStatus = 401;
    render(<AppV2 bookUuid={BOOK} />);
    await flipLanguage();
    expect(
      await screen.findByText(
        /signed out, so your place is only saved on this device/
      )
    ).toBeInTheDocument();
    expect(saves()).toHaveLength(1);
    // The position is still kept on this device.
    expect(localStorage.getItem('ovid_progress_v2_book-1')).toContain(
      '"chapter":1'
    );
  });

  it('saves quietly when the server accepts it', async () => {
    mockUser = { id: 1, email: 'a@b.c', name: 'A' };
    render(<AppV2 bookUuid={BOOK} />);
    await flipLanguage();
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends nothing to the server for a signed-out reader', async () => {
    mockUser = null;
    render(<AppV2 bookUuid={BOOK} />);
    await flipLanguage();
    await new Promise((r) => setTimeout(r, 50));
    expect(saves()).toHaveLength(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

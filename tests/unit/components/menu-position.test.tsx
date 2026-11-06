import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import BilingualReaderV2 from '../../../src/components/BilingualReaderV2';
import { en } from '../../../src/i18n/en';

// The menu says which chapter is open and how far through the book it is.

class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.IntersectionObserver = MockIntersectionObserver as any;

// Chapter numbers skip 2, so the position comes from the list, not the number.
const chapters = [1, 3, 4, 5].map((n, i) => ({
  id: n,
  chapter_number: n,
  title: `第${n}章`,
  original_title: `Chapter ${n} title`,
  order_index: i,
}));

const props = {
  rawHtml: '<body><p>Hello</p></body>',
  translations: [
    { xpath: '/body[1]/p[1]', original_text: 'Hello', translated_text: '你好' },
  ],
  title: 'Test Book',
  author: 'Test Author',
  currentChapter: 3,
  totalChapters: 4,
  chapters,
  onLoadChapter: vi.fn(),
  isLoading: false,
};

const setScroll = (scrollY: number, scrollHeight: number) => {
  Object.defineProperty(window, 'scrollY', {
    value: scrollY,
    configurable: true,
  });
  Object.defineProperty(window, 'innerHeight', {
    value: 1000,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: scrollHeight,
    configurable: true,
  });
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ovid_onboarding_seen', '1');
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as any;
});

afterEach(() => {
  delete (window as any).matchMedia;
  setScroll(0, 0);
});

const openMenu = () =>
  fireEvent.click(screen.getByRole('button', { name: en.reader.menu }));

describe('reading position in the menu', () => {
  it('shows the chapter title, its place in the book and the percent read', () => {
    // Halfway through the 2nd of 4 chapters: (1 + 0.5) / 4 = 38%.
    setScroll(500, 2000);
    render(<BilingualReaderV2 {...props} />);
    openMenu();
    expect(screen.getByText('Chapter 3 title')).toBeInTheDocument();
    expect(
      screen.getByText(
        `${en.reader.chapterOf(2, 4)} · ${en.reader.bookPercent(38)}`
      )
    ).toBeInTheDocument();
  });

  it('measures again each time the menu opens', () => {
    setScroll(0, 2000);
    render(<BilingualReaderV2 {...props} />);
    openMenu();
    expect(screen.getByText(/25% of the book/)).toBeInTheDocument();
    openMenu(); // closes
    setScroll(1000, 2000);
    openMenu();
    expect(screen.getByText(/50% of the book/)).toBeInTheDocument();
  });

  it('counts a short chapter that does not scroll as just started', () => {
    setScroll(0, 800);
    render(<BilingualReaderV2 {...props} currentChapter={1} />);
    openMenu();
    expect(
      screen.getByText(/Chapter 1 of 4 · 0% of the book/)
    ).toBeInTheDocument();
  });
});

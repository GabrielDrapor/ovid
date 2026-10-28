import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import BilingualReaderV2 from '../../../src/components/BilingualReaderV2';
import { en } from '../../../src/i18n/en';

// Tapping a paragraph switches its language; selecting text in it must not,
// or the selection can't be copied.

class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.IntersectionObserver = MockIntersectionObserver as any;

const props = {
  rawHtml: '<body><p>Hello world</p></body>',
  translations: [
    {
      xpath: '/body[1]/p[1]',
      original_text: 'Hello world',
      translated_text: '你好世界',
    },
  ],
  title: 'Test Book',
  author: 'Test Author',
  currentChapter: 1,
  totalChapters: 1,
  chapters: [],
  onLoadChapter: vi.fn(),
  isLoading: false,
};

const paragraph = () =>
  document.querySelector('[data-bilingual]') as HTMLElement;

/** The reader maps paragraphs to translations shortly after it renders. */
async function renderReader() {
  render(<BilingualReaderV2 {...props} />);
  await waitFor(() => expect(paragraph()).not.toBeNull());
}

/** A click as the browser sends it: press, release, click. */
function click(
  el: HTMLElement,
  { from = [10, 10], to = from, detail = 1 } = {} as {
    from?: number[];
    to?: number[];
    detail?: number;
  }
) {
  fireEvent.pointerDown(el, { clientX: from[0], clientY: from[1] });
  fireEvent.click(el, { clientX: to[0], clientY: to[1], detail });
}

function select(el: HTMLElement, start: number, end: number) {
  const text = el.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ovid_onboarding_seen', '1');
  window.getSelection()?.removeAllRanges();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as any;
});

afterEach(() => {
  delete (window as any).matchMedia;
  delete (document as any).caretRangeFromPoint;
});

describe('tapping and selecting a paragraph', () => {
  it('switches the language on a tap', async () => {
    await renderReader();
    expect(paragraph()).toHaveTextContent('Hello world');
    click(paragraph());
    expect(paragraph()).toHaveTextContent('你好世界');
    click(paragraph());
    expect(paragraph()).toHaveTextContent('Hello world');
  });

  it('leaves the language alone when a drag selected text', async () => {
    await renderReader();
    select(paragraph(), 0, 5);
    click(paragraph(), { from: [10, 10], to: [80, 12] });
    expect(paragraph()).toHaveTextContent('Hello world');
    expect(window.getSelection()!.toString()).toBe('Hello');
  });

  it('leaves the language alone while a selection reaches into the paragraph', async () => {
    await renderReader();
    select(paragraph(), 6, 11);
    click(paragraph());
    expect(paragraph()).toHaveTextContent('Hello world');
  });

  it('treats a drag that selected nothing as a drag, not a tap', async () => {
    await renderReader();
    click(paragraph(), { from: [10, 10], to: [40, 30] });
    expect(paragraph()).toHaveTextContent('Hello world');
  });

  it('selects a word on a double-click and keeps the language', async () => {
    await renderReader();
    // jsdom has no layout: point the caret into "world", and give every
    // character an empty box.
    (document as any).caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(paragraph().firstChild!, 8);
      return r;
    };
    Range.prototype.getBoundingClientRect = () =>
      ({ left: 0, right: 0, top: 0, bottom: 0 }) as DOMRect;

    click(paragraph(), { detail: 1 });
    expect(paragraph()).toHaveTextContent('你好世界');
    click(paragraph(), { detail: 2 });
    expect(paragraph()).toHaveTextContent('Hello world');
    expect(window.getSelection()!.toString()).toBe('world');
  });
});

describe('paragraphs and the keyboard', () => {
  it('takes focus and switches with Enter', async () => {
    await renderReader();
    const p = paragraph();
    expect(p.tabIndex).toBe(0);
    p.focus();
    fireEvent.keyDown(p, { key: 'Enter' });
    expect(p).toHaveTextContent('你好世界');
    fireEvent.keyDown(p, { key: ' ' });
    expect(p).toHaveTextContent('你好世界');
  });

  it('starts with a link that skips to the menu', async () => {
    await renderReader();
    fireEvent.click(screen.getByRole('button', { name: en.reader.skipToMenu }));
    expect(screen.getByRole('button', { name: en.reader.menu })).toHaveFocus();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom';
import BilingualReaderV2 from '../../../src/components/BilingualReaderV2';
import { en } from '../../../src/i18n/en';

// Esc, focus and scroll for the reader's menu, contents, search and note
// popover; the Share page; search counts, paging and errors.

class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.IntersectionObserver = MockIntersectionObserver as any;

const chapters = [1, 2, 3].map((n) => ({
  id: n,
  chapter_number: n,
  title: `第${n}章`,
  original_title: `Chapter ${n}`,
  order_index: n - 1,
}));

const NOTE_XPATH = '/body[1]/p[2]';
const baseProps = {
  rawHtml:
    '<body><p>Hello <a href="#n1" data-ov-chapter="2" data-ov-xpath="/body[1]/p[2]" data-ov-note="">1</a></p><p>The note.</p></body>',
  translations: [
    {
      xpath: '/body[1]/p[1]',
      original_text: 'Hello 1',
      translated_text: '你好',
    },
    {
      xpath: NOTE_XPATH,
      original_text: 'The note.',
      translated_text: '注释。',
    },
  ],
  title: 'Test Book',
  author: 'Test Author',
  currentChapter: 2,
  totalChapters: 3,
  chapters,
  onLoadChapter: vi.fn(),
  isLoading: false,
  bookUuid: 'book-1',
  onNavigateInternal: vi.fn(),
};

const key = (k: string, target: Element | Document = document) =>
  fireEvent.keyDown(target, { key: k });
const openMenu = () =>
  fireEvent.click(screen.getByRole('button', { name: en.reader.menu }));
const openContents = () => {
  openMenu();
  fireEvent.click(screen.getByRole('button', { name: en.reader.chapters }));
};
const openSearch = () => {
  openMenu();
  fireEvent.click(screen.getByRole('button', { name: en.reader.search }));
};

const reply = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
const result = (n: number) => ({
  chapter: 1,
  chapterTitle: 'Chapter 1',
  xpath: `/body[1]/p[${n}]`,
  field: 'original',
  snippet: `match ${n}`,
});

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
  vi.useRealTimers();
});

describe('Escape and focus in the reader', () => {
  it('closes the menu and gives focus back to the menu button', () => {
    render(<BilingualReaderV2 {...baseProps} />);
    openMenu();
    // Focus moves into the menu, onto its first item.
    expect(
      screen.getByRole('button', { name: en.reader.showTranslation })
    ).toHaveFocus();
    key('Escape');
    expect(
      screen.queryByRole('button', { name: en.reader.chapters })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.reader.menu })).toHaveFocus();
  });

  it('opens the contents on the current chapter and closes them with Escape', () => {
    render(<BilingualReaderV2 {...baseProps} />);
    openContents();
    const dialog = screen.getByRole('dialog', { name: en.reader.contents });
    const current = screen.getByRole('button', { current: true });
    expect(current).toHaveTextContent('Chapter 2');
    expect(current).toHaveFocus();
    expect(document.documentElement.style.overflow).toBe('hidden');

    key('Escape');
    expect(dialog).not.toBeInTheDocument();
    expect(document.documentElement.style.overflow).toBe('');
    expect(screen.getByRole('button', { name: en.reader.menu })).toHaveFocus();
  });

  it('keeps Tab inside the contents panel', () => {
    render(<BilingualReaderV2 {...baseProps} />);
    openContents();
    const close = screen.getByRole('button', { name: en.common.close });
    const items = screen.getAllByRole('button', { name: /Chapter \d/ });
    items[items.length - 1].focus();
    key('Tab', items[items.length - 1]);
    expect(close).toHaveFocus();
  });

  it('closes only the note popover, and arrow keys leave the chapter alone', () => {
    const onLoadChapter = vi.fn();
    render(<BilingualReaderV2 {...baseProps} onLoadChapter={onLoadChapter} />);
    fireEvent.click(screen.getByText('1'));
    const note = screen.getByRole('dialog', { name: /Note 1/ });
    expect(note).toHaveTextContent('The note.');

    key('ArrowRight');
    expect(onLoadChapter).not.toHaveBeenCalled();

    key('Escape');
    expect(note).not.toBeInTheDocument();
    key('ArrowRight');
    expect(onLoadChapter).toHaveBeenCalledWith(3);
  });
});

describe('search', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as any;
  });

  const search = async (q: string) => {
    openSearch();
    const input = screen.getByRole('searchbox', { name: en.reader.search });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: q } });
  };

  it('counts the results and loads more from a button', async () => {
    fetchMock
      .mockReturnValueOnce(
        reply({ query: 'm', results: [result(1), result(2)], hasMore: true })
      )
      .mockReturnValueOnce(
        reply({ query: 'm', results: [result(3)], hasMore: false })
      );
    render(<BilingualReaderV2 {...baseProps} />);
    await search('m');

    expect(await screen.findByText('2+ results')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: en.reader.showMoreResults })
    );
    expect(await screen.findByText('3 results')).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toContain('offset=2');
    expect(
      screen.queryByRole('button', { name: en.reader.showMoreResults })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(en.reader.searching)).not.toBeInTheDocument();
  });

  it('says when the search failed and tries again', async () => {
    fetchMock
      .mockReturnValueOnce(reply({ error: 'boom' }, 500))
      .mockReturnValueOnce(
        reply({ query: 'm', results: [result(1)], hasMore: false })
      );
    render(<BilingualReaderV2 {...baseProps} />);
    await search('m');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      en.reader.searchFailed
    );
    fireEvent.click(screen.getByRole('button', { name: en.errors.tryAgain }));
    expect(await screen.findByText('1 result')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('closes with Escape and turns no pages behind it', async () => {
    const onLoadChapter = vi.fn();
    render(<BilingualReaderV2 {...baseProps} onLoadChapter={onLoadChapter} />);
    openSearch();
    key('ArrowRight', document.body);
    expect(onLoadChapter).not.toHaveBeenCalled();
    key('Escape');
    expect(
      screen.queryByRole('dialog', { name: en.reader.search })
    ).not.toBeInTheDocument();
  });
});

describe('Share page', () => {
  const ownerProps = {
    ...baseProps,
    isOwner: true,
    onShare: vi.fn().mockResolvedValue(undefined),
    onRevokeShare: vi.fn().mockResolvedValue(undefined),
  };
  const openShare = () => {
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: /^Share/ }));
  };
  const setClipboard = (writeText: () => Promise<void>) =>
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(writeText) },
      configurable: true,
    });

  beforeEach(() => {
    ownerProps.onShare.mockClear();
    ownerProps.onRevokeShare.mockClear();
    delete (navigator as any).share;
  });

  it('creates a link only when asked', async () => {
    render(<BilingualReaderV2 {...ownerProps} shareToken={null} />);
    openShare();
    expect(screen.getByText(en.reader.shareIntro)).toBeInTheDocument();
    expect(ownerProps.onShare).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: en.reader.createShareLink })
      );
    });
    expect(ownerProps.onShare).toHaveBeenCalledTimes(1);
  });

  it('shows the link and says when copying worked', async () => {
    setClipboard(() => Promise.resolve());
    render(<BilingualReaderV2 {...ownerProps} shareToken="tok" />);
    openShare();
    const link = screen.getByRole('textbox', { name: en.reader.shareLink });
    expect(link).toHaveValue(`${window.location.origin}/shared/tok`);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.reader.copyLink }));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/shared/tok`
    );
    expect(screen.getByRole('status')).toHaveTextContent(en.reader.copied);
  });

  it('says when copying failed and selects the link instead', async () => {
    setClipboard(() => Promise.reject(new Error('denied')));
    render(<BilingualReaderV2 {...ownerProps} shareToken="tok" />);
    openShare();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.reader.copyLink }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(en.reader.copyFailed);
    expect(screen.queryByText(en.reader.copied)).not.toBeInTheDocument();
  });

  it('offers the system share sheet where there is one', () => {
    (navigator as any).share = vi.fn().mockResolvedValue(undefined);
    render(<BilingualReaderV2 {...ownerProps} shareToken="tok" />);
    openShare();
    fireEvent.click(screen.getByRole('button', { name: en.reader.shareVia }));
    expect((navigator as any).share).toHaveBeenCalledWith({
      url: `${window.location.origin}/shared/tok`,
    });
  });

  it('asks before it stops sharing', async () => {
    render(<BilingualReaderV2 {...ownerProps} shareToken="tok" />);
    openShare();

    fireEvent.click(
      screen.getByRole('button', { name: en.reader.stopSharing })
    );
    const ask = screen.getByRole('alertdialog', {
      name: en.reader.stopSharingTitle,
    });
    // Escape closes the question, not the menu under it.
    key('Escape');
    expect(ask).not.toBeInTheDocument();
    expect(ownerProps.onRevokeShare).not.toHaveBeenCalled();
    expect(
      screen.getByRole('textbox', { name: en.reader.shareLink })
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: en.reader.stopSharing })
    );
    const confirmButton = screen
      .getAllByRole('button', { name: en.reader.stopSharing })
      .find((b) => b.closest('.ov-dialog'))!;
    await act(async () => {
      fireEvent.click(confirmButton);
    });
    await waitFor(() =>
      expect(ownerProps.onRevokeShare).toHaveBeenCalledTimes(1)
    );
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import BilingualReaderV2 from '../../../src/components/BilingualReaderV2';
import { Icon, Spinner } from '../../../src/components/Icon';
import { en } from '../../../src/i18n/en';

// jsdom has no IntersectionObserver; the reader only needs it to exist.
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.IntersectionObserver = MockIntersectionObserver as any;

const baseProps = {
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
  chapters: [
    {
      id: 1,
      chapter_number: 1,
      title: '第一章',
      original_title: 'Chapter 1',
      order_index: 0,
    },
  ],
  onLoadChapter: vi.fn(),
  isLoading: false,
};

const openMenu = () =>
  fireEvent.click(screen.getByRole('button', { name: en.reader.menu }));

describe('Icon', () => {
  it('is decorative and sized by the surrounding text by default', () => {
    const { container } = render(<Icon name="close" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('width', '1em');
    expect(svg).toHaveAttribute('height', '1em');
  });

  it('takes an explicit size', () => {
    const { container } = render(<Icon name="check" size={18} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '18');
  });

  it('renders a spinner hidden from screen readers', () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector('.ov-spinner')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Reader icon buttons', () => {
  beforeEach(() => {
    localStorage.clear();
    // Keep the first-visit tooltip out of the way.
    localStorage.setItem('ovid_onboarding_seen', '1');
  });

  it('gives the contents panel close button a name instead of an X', () => {
    render(<BilingualReaderV2 {...baseProps} />);
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: en.reader.chapters }));

    const close = screen.getByRole('button', { name: en.common.close });
    expect(close.querySelector('svg')).toBeInTheDocument();
    expect(close).not.toHaveTextContent('X');
  });

  it('gives the search panel close button a name', () => {
    render(
      <BilingualReaderV2
        {...baseProps}
        bookUuid="book-1"
        onNavigateInternal={vi.fn()}
      />
    );
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: en.reader.search }));

    expect(
      screen.getByRole('button', { name: en.common.close })
    ).toBeInTheDocument();
  });

  it('names each typography − / + button after its setting', () => {
    render(<BilingualReaderV2 {...baseProps} />);
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: en.reader.typography }));

    for (const setting of [en.reader.fontSize, en.reader.fontWeight]) {
      expect(
        screen.getByRole('button', { name: en.reader.decrease(setting) })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: en.reader.increase(setting) })
      ).toBeInTheDocument();
    }
  });

  it('shows the read state as a switch with no ✓ character', () => {
    render(
      <BilingualReaderV2
        {...baseProps}
        isCompleted
        onMarkComplete={vi.fn().mockResolvedValue(undefined)}
      />
    );
    openMenu();

    const item = screen.getByRole('switch', { name: en.reader.markAsRead });
    expect(item).toHaveAttribute('aria-checked', 'true');
    expect(item).not.toHaveTextContent('✓');
  });

  it('shows a spinner while marking the book as read', async () => {
    // Never settles, so the button stays busy for the assertion.
    const onMarkComplete = vi.fn(() => new Promise<void>(() => {}));
    render(
      <BilingualReaderV2 {...baseProps} onMarkComplete={onMarkComplete} />
    );
    openMenu();

    const item = screen.getByRole('switch', { name: en.reader.markAsRead });
    fireEvent.click(item);

    await waitFor(() => {
      expect(item.querySelector('.ov-spinner')).toBeInTheDocument();
    });
    expect(item).toBeDisabled();
    expect(item).not.toHaveTextContent('...');
  });
});

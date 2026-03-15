import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock IntersectionObserver for jsdom
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(callback: any, options?: any) {}
}
global.IntersectionObserver = MockIntersectionObserver as any;

// Mock CSS import
vi.mock('../../../src/components/BilingualReader.css', () => ({}));

// We test the onboarding tooltip behavior by testing BilingualReaderV2 directly
import BilingualReaderV2 from '../../../src/components/BilingualReaderV2';

const MOCK_TRANSLATIONS = [
  {
    xpath: '/body[1]/p[1]',
    original_text: 'Hello world',
    translated_text: '你好世界',
  },
  {
    xpath: '/body[1]/p[2]',
    original_text: 'Second paragraph',
    translated_text: '第二段',
  },
];

const MOCK_CHAPTERS = [
  { id: 1, chapter_number: 1, title: '第一章', original_title: 'Chapter 1', order_index: 0 },
];

const defaultProps = {
  rawHtml: '<body><p>Hello world</p><p>Second paragraph</p></body>',
  translations: MOCK_TRANSLATIONS,
  title: 'Test Book',
  author: 'Test Author',
  currentChapter: 1,
  totalChapters: 1,
  chapters: MOCK_CHAPTERS,
  onLoadChapter: vi.fn(),
  isLoading: false,
};

describe('Onboarding Tooltip', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows tooltip on first visit when translations are ready', async () => {
    vi.useRealTimers(); // Need real timers for this test
    
    const { container } = render(<BilingualReaderV2 {...defaultProps} />);

    // Wait for translations to apply (100ms delay) + tooltip to show (500ms delay)
    await waitFor(() => {
      const tooltip = container.querySelector('.onboarding-tooltip');
      expect(tooltip).toBeInTheDocument();
    }, { timeout: 2000 });

    expect(screen.getByText('点击段落切换原文/翻译')).toBeInTheDocument();
    expect(screen.getByText('Click any paragraph to toggle translation')).toBeInTheDocument();
  });

  it('does not show tooltip if already seen', async () => {
    vi.useRealTimers();
    localStorage.setItem('ovid_onboarding_seen', '1');

    const { container } = render(<BilingualReaderV2 {...defaultProps} />);

    // Wait enough time for it to potentially appear
    await new Promise(r => setTimeout(r, 1000));

    const tooltip = container.querySelector('.onboarding-tooltip');
    expect(tooltip).not.toBeInTheDocument();
  });

  it('dismisses tooltip on click and saves to localStorage', async () => {
    vi.useRealTimers();

    const { container } = render(<BilingualReaderV2 {...defaultProps} />);

    // Wait for tooltip to appear
    await waitFor(() => {
      expect(container.querySelector('.onboarding-tooltip')).toBeInTheDocument();
    }, { timeout: 2000 });

    // Click the tooltip
    const tooltip = container.querySelector('.onboarding-tooltip')!;
    fireEvent.click(tooltip);

    // Tooltip should be gone
    await waitFor(() => {
      expect(container.querySelector('.onboarding-tooltip')).not.toBeInTheDocument();
    });

    // localStorage should be set
    expect(localStorage.getItem('ovid_onboarding_seen')).toBe('1');
  });

  it('does not show tooltip again after dismissal and re-render', async () => {
    vi.useRealTimers();

    // First render - tooltip shows
    const { container, unmount } = render(<BilingualReaderV2 {...defaultProps} />);

    await waitFor(() => {
      expect(container.querySelector('.onboarding-tooltip')).toBeInTheDocument();
    }, { timeout: 2000 });

    // Dismiss it
    fireEvent.click(container.querySelector('.onboarding-tooltip')!);

    await waitFor(() => {
      expect(container.querySelector('.onboarding-tooltip')).not.toBeInTheDocument();
    });

    unmount();

    // Second render - tooltip should NOT show
    const { container: container2 } = render(<BilingualReaderV2 {...defaultProps} />);

    await new Promise(r => setTimeout(r, 1000));
    expect(container2.querySelector('.onboarding-tooltip')).not.toBeInTheDocument();
  });
});

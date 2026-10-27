import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import BilingualReaderV2, {
  TYPOGRAPHY_STEPS,
  stepsFromDefault,
} from '../../../src/components/BilingualReaderV2';
import ReaderStatus from '../../../src/components/ReaderStatus';
import { READER_THEMES, resolveTheme } from '../../../src/reader/themes';
import { en } from '../../../src/i18n/en';

// jsdom has no IntersectionObserver or matchMedia; the reader only needs them
// to exist.
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
  currentChapter: 2,
  totalChapters: 3,
  chapters,
  onLoadChapter: vi.fn(),
  isLoading: false,
};

const openMenu = () =>
  fireEvent.click(screen.getByRole('button', { name: en.reader.menu }));

const openTypography = () => {
  openMenu();
  fireEvent.click(screen.getByRole('button', { name: en.reader.typography }));
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
});

describe('chapter navigation buttons', () => {
  it('name the neighbouring chapters in the language on the page', () => {
    render(<BilingualReaderV2 {...baseProps} />);
    expect(
      screen.getByRole('button', { name: /Previous chapter.*Chapter 1/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Next chapter.*Chapter 3/ })
    ).toBeInTheDocument();
  });

  it('use the translated titles while the translation is shown', () => {
    render(<BilingualReaderV2 {...baseProps} initialShowOriginal={false} />);
    expect(
      screen.getByRole('button', { name: /Next chapter.*第3章/ })
    ).toBeInTheDocument();
  });

  it('load the next chapter', () => {
    const onLoadChapter = vi.fn();
    render(<BilingualReaderV2 {...baseProps} onLoadChapter={onLoadChapter} />);
    fireEvent.click(screen.getByRole('button', { name: /Next chapter/ }));
    expect(onLoadChapter).toHaveBeenCalledWith(3);
  });
});

describe('typography page', () => {
  it('replaces the main list and goes back to it', () => {
    render(<BilingualReaderV2 {...baseProps} />);
    openTypography();

    expect(
      screen.queryByRole('button', { name: en.reader.chapters })
    ).not.toBeInTheDocument();
    const back = screen.getByRole('button', { name: en.common.back });
    expect(back).toHaveFocus();

    fireEvent.click(back);
    expect(
      screen.getByRole('button', { name: en.reader.chapters })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: en.reader.typography })
    ).toHaveFocus();
  });

  it('reopens on the main list after the menu closes', () => {
    render(<BilingualReaderV2 {...baseProps} />);
    openTypography();
    fireEvent.click(screen.getByRole('button', { name: en.reader.menu }));
    openMenu();
    expect(
      screen.getByRole('button', { name: en.reader.chapters })
    ).toBeInTheDocument();
  });

  it('shows steps from the default instead of raw values', () => {
    render(<BilingualReaderV2 {...baseProps} />);
    openTypography();

    const row = screen.getByText(en.reader.letterSpacing).parentElement!;
    expect(row).toHaveTextContent(en.reader.defaultValue);
    fireEvent.click(
      screen.getByRole('button', {
        name: en.reader.increase(en.reader.letterSpacing),
      })
    );
    expect(row).toHaveTextContent('+1');
    expect(row).not.toHaveTextContent('-0.02');
  });

  it('disables − and + at the ends of a range', () => {
    render(<BilingualReaderV2 {...baseProps} />);
    openTypography();

    // Paragraph gap starts at its minimum.
    expect(
      screen.getByRole('button', {
        name: en.reader.decrease(en.reader.paragraphGap),
      })
    ).toBeDisabled();

    const bigger = screen.getByRole('button', {
      name: en.reader.increase(en.reader.fontSize),
    });
    const { def, max } = TYPOGRAPHY_STEPS.fontSize;
    for (let size = def; size < max; size++) fireEvent.click(bigger);
    expect(bigger).toBeDisabled();
    expect(
      screen.getByText(en.reader.fontSize).parentElement
    ).toHaveTextContent(String(max));
  });

  it('snaps a value saved with an older step size back onto the grid', () => {
    localStorage.setItem(
      'ovid_typography',
      JSON.stringify({ wordSpacing: 0.03 })
    );
    render(<BilingualReaderV2 {...baseProps} />);
    openTypography();
    fireEvent.click(
      screen.getByRole('button', {
        name: en.reader.increase(en.reader.wordSpacing),
      })
    );
    const saved = JSON.parse(localStorage.getItem('ovid_typography')!);
    expect(saved.wordSpacing).toBe(0.1);
    expect(
      stepsFromDefault(saved.wordSpacing, TYPOGRAPHY_STEPS.wordSpacing)
    ).toBe(2);
  });

  it('keeps every range on its step grid', () => {
    for (const [key, spec] of Object.entries(TYPOGRAPHY_STEPS)) {
      for (const end of [spec.min, spec.max]) {
        const steps = (end - spec.def) / spec.step;
        expect(Math.abs(steps - Math.round(steps)), key).toBeLessThan(1e-9);
      }
    }
  });
});

describe('theme options', () => {
  it('show each theme by name and mark the chosen one', () => {
    render(<BilingualReaderV2 {...baseProps} />);
    openMenu();

    const sepia = screen.getByRole('button', {
      name: en.reader.themeNames.sepia,
    });
    expect(sepia).toBeVisible();
    expect(screen.getByText(en.reader.themeAutoShort)).toBeInTheDocument();
    fireEvent.click(sepia);
    expect(sepia).toHaveAttribute('aria-pressed', 'true');
    expect(sepia).not.toHaveTextContent('A' + en.reader.themeNames.sepia);
  });
});

describe('browser bar colour', () => {
  it('follows the reader theme and is restored afterwards', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#000000';
    document.head.appendChild(meta);

    const { unmount } = render(<ReaderStatus>Loading…</ReaderStatus>);
    expect(meta.content).toBe(resolveTheme('auto', false).colors.bg);
    unmount();
    expect(meta.content).toBe('#000000');
    meta.remove();
  });
});

describe('pre-paint script in index.html', () => {
  const html = fs.readFileSync(
    path.resolve(__dirname, '../../../public/index.html'),
    'utf8'
  );
  const script = html.match(/<body>\s*<script>([\s\S]*?)<\/script>/)![1];
  const run = (pathname: string) => {
    window.history.pushState({}, '', pathname);
    document.body.style.backgroundColor = '';
    new Function(script)();
    return document.body.style.backgroundColor;
  };
  // jsdom reports colours as rgb(); compare through the same conversion.
  const css = (color: string) => {
    const el = document.createElement('div');
    el.style.backgroundColor = color;
    return el.style.backgroundColor;
  };

  afterEach(() => window.history.pushState({}, '', '/'));

  it('paints every theme with the same colour as READER_THEMES', () => {
    for (const theme of READER_THEMES) {
      localStorage.setItem('ovid_reader_theme', theme.id);
      expect(run('/book/abc'), theme.id).toBe(css(theme.colors.bg));
    }
  });

  it('follows the system setting for auto, like the reader', () => {
    localStorage.setItem('ovid_reader_theme', 'auto');
    expect(run('/shared/token')).toBe(
      css(resolveTheme('auto', false).colors.bg)
    );
    (window.matchMedia as any).mockReturnValue({ matches: true });
    expect(run('/book/abc')).toBe(css(resolveTheme('auto', true).colors.bg));
  });

  it('leaves the shelf alone', () => {
    localStorage.setItem('ovid_reader_theme', 'dark');
    expect(run('/')).toBe('');
  });
});

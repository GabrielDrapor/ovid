import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { en } from '../../src/i18n/en';
import { zh } from '../../src/i18n/zh';
import { detectLocale, getMessages, LOCALE_STORAGE_KEY } from '../../src/i18n';

// Recursively collect "key paths" with the value's shape (type + function
// arity), so a locale can't drift from the en source of truth.
function shape(obj: unknown, prefix = ''): string[] {
  if (typeof obj === 'function') {
    return [`${prefix}:fn/${(obj as Function).length}`];
  }
  if (Array.isArray(obj)) {
    return [`${prefix}:array`];
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>)
      .flatMap(([key, value]) =>
        shape(value, prefix ? `${prefix}.${key}` : key)
      )
      .sort();
  }
  return [`${prefix}:${typeof obj}`];
}

describe('i18n dictionaries', () => {
  it('zh matches the structure of en (keys, types, function arities)', () => {
    expect(shape(zh)).toEqual(shape(en));
  });

  it('has no empty messages', () => {
    const check = (obj: Record<string, unknown>, path: string) => {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
          expect(value.trim(), `${path}.${key}`).not.toBe('');
        } else if (Array.isArray(value)) {
          expect(value.length, `${path}.${key}`).toBeGreaterThan(0);
        } else if (value !== null && typeof value === 'object') {
          check(value as Record<string, unknown>, `${path}.${key}`);
        }
      }
    };
    check(en, 'en');
    check(zh, 'zh');
  });

  it('interpolating functions produce distinct localized output', () => {
    expect(en.shelf.translatingProgress(3, 10, 30)).toContain('3/10');
    expect(zh.shelf.translatingProgress(3, 10, 30)).toContain('3/10');
    expect(en.shelf.byAuthor('Ovid')).toContain('Ovid');
    expect(zh.shelf.byAuthor('Ovid')).toContain('Ovid');
    expect(en.upload.needMore('1,200')).toContain('1,200');
    expect(zh.upload.needMore('1,200')).toContain('1,200');
  });

  it('getMessages returns the requested dictionary', () => {
    expect(getMessages('en')).toBe(en);
    expect(getMessages('zh')).toBe(zh);
  });
});

describe('detectLocale', () => {
  const originalLanguages = navigator.languages;
  const originalLanguage = navigator.language;

  const setNavigatorLanguage = (lang: string) => {
    Object.defineProperty(navigator, 'languages', {
      value: [lang],
      configurable: true,
    });
    Object.defineProperty(navigator, 'language', {
      value: lang,
      configurable: true,
    });
  };

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'languages', {
      value: originalLanguages,
      configurable: true,
    });
    Object.defineProperty(navigator, 'language', {
      value: originalLanguage,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it('prefers a stored locale over the browser language', () => {
    setNavigatorLanguage('en-US');
    localStorage.setItem(LOCALE_STORAGE_KEY, 'zh');
    expect(detectLocale()).toBe('zh');
  });

  it('ignores an invalid stored value', () => {
    setNavigatorLanguage('en-US');
    localStorage.setItem(LOCALE_STORAGE_KEY, 'fr');
    expect(detectLocale()).toBe('en');
  });

  it.each([
    ['zh', 'zh'],
    ['zh-CN', 'zh'],
    ['zh-Hant-TW', 'zh'],
    ['en-US', 'en'],
    ['fr-FR', 'en'],
    ['ja', 'en'],
  ])('maps browser language %s to %s', (browserLang, expected) => {
    setNavigatorLanguage(browserLang);
    expect(detectLocale()).toBe(expected);
  });
});

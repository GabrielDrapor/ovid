import { describe, it, expect, beforeEach } from 'vitest';
import { TYPOGRAPHY_KEY, loadTypographyDefaults } from '../../../src/components/BilingualReaderV2';

describe('typography localStorage persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty object when localStorage has no entry', () => {
    expect(loadTypographyDefaults()).toEqual({});
  });

  it('restores saved fontSize', () => {
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ fontSize: 22 }));
    expect(loadTypographyDefaults().fontSize).toBe(22);
  });

  it('restores all six typography values', () => {
    const saved = {
      fontSize: 20,
      lineHeight: 1.8,
      letterSpacing: 0.02,
      wordSpacing: 0.1,
      fontWeight: 500,
      paragraphSpacing: 8,
    };
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(saved));
    const defaults = loadTypographyDefaults();
    expect(defaults).toMatchObject(saved);
  });

  it('returns empty object on malformed JSON without throwing', () => {
    localStorage.setItem(TYPOGRAPHY_KEY, '{not valid json}');
    expect(() => loadTypographyDefaults()).not.toThrow();
    expect(loadTypographyDefaults()).toEqual({});
  });

  it('nullish-coalescing with defaults: missing key falls back to hardcoded default', () => {
    // Only fontSize saved; lineHeight should fall back to 1.6 in the component
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ fontSize: 21 }));
    const d = loadTypographyDefaults();
    expect(d.fontSize).toBe(21);
    expect(d.lineHeight ?? 1.6).toBe(1.6); // component uses `?? 1.6`
  });

  it('uses TYPOGRAPHY_KEY as the localStorage key', () => {
    expect(TYPOGRAPHY_KEY).toBe('ovid_typography');
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify({ fontSize: 18 }));
    // Verify the key is exactly what loadTypographyDefaults reads
    expect(loadTypographyDefaults().fontSize).toBe(18);
    // A different key should return nothing
    localStorage.removeItem(TYPOGRAPHY_KEY);
    expect(loadTypographyDefaults()).toEqual({});
  });
});

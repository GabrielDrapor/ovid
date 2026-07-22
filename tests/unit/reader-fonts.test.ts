import { describe, it, expect } from 'vitest';
import {
  READER_FONTS,
  DEFAULT_FONT_ID,
  fontStack,
} from '../../src/reader/fonts';

describe('reader fonts', () => {
  it('has unique ids', () => {
    const ids = READER_FONTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('default is the first (song) entry', () => {
    expect(DEFAULT_FONT_ID).toBe('song');
    expect(READER_FONTS[0].id).toBe(DEFAULT_FONT_ID);
  });

  it('resolves each id to its own stack', () => {
    for (const f of READER_FONTS) {
      expect(fontStack(f.id)).toBe(f.stack);
    }
  });

  it('falls back to the default stack for unknown/missing ids', () => {
    const def = READER_FONTS[0].stack;
    expect(fontStack('comic-sans')).toBe(def);
    expect(fontStack(undefined)).toBe(def);
    expect(fontStack(null)).toBe(def);
  });

  it('every stack ends in a generic family', () => {
    for (const f of READER_FONTS) {
      expect(f.stack).toMatch(/(serif|sans-serif)$/);
    }
  });

  it('song keeps the original reader pairing', () => {
    expect(fontStack('song')).toContain('LXGW Neo ZhiSong Screen');
    expect(fontStack('kai')).toContain('LXGW WenKai Screen');
  });
});

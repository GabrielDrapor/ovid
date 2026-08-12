import { describe, it, expect } from 'vitest';
import { chooseTranslationBackend } from '../../../src/worker/translation/backend-choice';

describe('chooseTranslationBackend', () => {
  it('defaults to railway with no configuration', () => {
    expect(chooseTranslationBackend('a@b.com', {})).toBe('railway');
  });

  it('routes allowlisted emails to cf (case- and space-insensitive)', () => {
    const env = { CF_TRANSLATION_ALLOWLIST: ' Owner@Example.com , second@x.io ' };
    expect(chooseTranslationBackend('owner@example.com', env)).toBe('cf');
    expect(chooseTranslationBackend('SECOND@X.IO', env)).toBe('cf');
    expect(chooseTranslationBackend('other@x.io', env)).toBe('railway');
  });

  it('keeps missing emails on railway even with an allowlist', () => {
    const env = { CF_TRANSLATION_ALLOWLIST: 'owner@example.com' };
    expect(chooseTranslationBackend(null, env)).toBe('railway');
    expect(chooseTranslationBackend(undefined, env)).toBe('railway');
    expect(chooseTranslationBackend('', env)).toBe('railway');
  });

  it('CF_TRANSLATION_DEFAULT flips everyone to cf (M3)', () => {
    expect(chooseTranslationBackend('anyone@x.io', { CF_TRANSLATION_DEFAULT: '1' })).toBe('cf');
    expect(chooseTranslationBackend(null, { CF_TRANSLATION_DEFAULT: 'true' })).toBe('cf');
    expect(chooseTranslationBackend('a@b.com', { CF_TRANSLATION_DEFAULT: '0' })).toBe('railway');
  });

  it('an empty allowlist entry never matches', () => {
    expect(chooseTranslationBackend('a@b.com', { CF_TRANSLATION_ALLOWLIST: ' , ,' })).toBe('railway');
  });
});

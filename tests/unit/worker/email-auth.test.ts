import { describe, it, expect } from 'vitest';
import {
  normalizeEmail,
  abuseKeyForEmail,
  isDisposableEmail,
  generateLoginCode,
  sha256Hex,
  EMAIL_SIGNUP_BONUS,
} from '../../../src/worker/email-auth';

describe('email auth helpers', () => {
  describe('normalizeEmail', () => {
    it('lowercases and trims', () => {
      expect(normalizeEmail('  Foo.Bar@Example.COM ')).toBe(
        'foo.bar@example.com'
      );
    });

    it('rejects non-addresses', () => {
      expect(normalizeEmail('not-an-email')).toBeNull();
      expect(normalizeEmail('a@b')).toBeNull();
      expect(normalizeEmail('a b@c.com')).toBeNull();
      expect(normalizeEmail('')).toBeNull();
      expect(normalizeEmail(42)).toBeNull();
      expect(normalizeEmail(null)).toBeNull();
    });

    it('rejects over-long addresses', () => {
      expect(normalizeEmail('a'.repeat(250) + '@x.com')).toBeNull();
    });
  });

  describe('abuseKeyForEmail', () => {
    it('strips +tags everywhere', () => {
      expect(abuseKeyForEmail('user+tag1@example.com')).toBe(
        'user@example.com'
      );
      expect(abuseKeyForEmail('user+a+b@example.com')).toBe('user@example.com');
    });

    it('collapses gmail dots', () => {
      expect(abuseKeyForEmail('f.o.o.bar+x@gmail.com')).toBe(
        'foobar@gmail.com'
      );
      expect(abuseKeyForEmail('foobar@googlemail.com')).toBe(
        'foobar@googlemail.com'
      );
    });

    it('keeps dots for non-gmail domains', () => {
      expect(abuseKeyForEmail('f.o.o@example.com')).toBe('f.o.o@example.com');
    });
  });

  describe('isDisposableEmail', () => {
    it('flags known throwaway domains', () => {
      expect(isDisposableEmail('x@mailinator.com')).toBe(true);
      expect(isDisposableEmail('x@yopmail.com')).toBe(true);
    });

    it('passes normal domains', () => {
      expect(isDisposableEmail('x@gmail.com')).toBe(false);
      expect(isDisposableEmail('x@ovid.ink')).toBe(false);
    });
  });

  describe('generateLoginCode', () => {
    it('is always 6 digits', () => {
      for (let i = 0; i < 200; i++) {
        expect(generateLoginCode()).toMatch(/^\d{6}$/);
      }
    });

    it('varies across calls', () => {
      const codes = new Set(
        Array.from({ length: 50 }, () => generateLoginCode())
      );
      expect(codes.size).toBeGreaterThan(1);
    });
  });

  describe('sha256Hex', () => {
    it('produces the known digest', async () => {
      // echo -n "abc" | shasum -a 256
      expect(await sha256Hex('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );
    });

    it('binds email and code together', async () => {
      const a = await sha256Hex('a@x.com:123456');
      const b = await sha256Hex('b@x.com:123456');
      expect(a).not.toBe(b);
    });
  });

  it('email signup bonus stays below the Google bonus', () => {
    expect(EMAIL_SIGNUP_BONUS).toBeLessThanOrEqual(5000);
    expect(EMAIL_SIGNUP_BONUS).toBeGreaterThan(0);
  });
});

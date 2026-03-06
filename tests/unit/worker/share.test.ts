import { describe, it, expect, vi } from 'vitest';
import { createShareToken, getShareToken, revokeShareToken, getBookByShareToken } from '../../../src/worker/db';

function createMockDB(firstResult: any = null) {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstResult),
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  const db = {
    prepare: vi.fn().mockReturnValue(mockStatement),
    _statement: mockStatement,
  } as any;
  return db;
}

describe('share token', () => {
  describe('createShareToken', () => {
    it('creates a new token for book owner', async () => {
      const db = createMockDB({ id: 1, user_id: 42, share_token: null });
      const token = await createShareToken(db, 'book-uuid', 42);
      
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      // Should have called UPDATE to set token
      expect(db.prepare).toHaveBeenCalledTimes(2); // SELECT + UPDATE
    });

    it('returns existing token if already shared', async () => {
      const db = createMockDB({ id: 1, user_id: 42, share_token: 'existing-token' });
      const token = await createShareToken(db, 'book-uuid', 42);
      
      expect(token).toBe('existing-token');
      expect(db.prepare).toHaveBeenCalledTimes(1); // Only SELECT
    });

    it('throws Forbidden for non-owner', async () => {
      const db = createMockDB({ id: 1, user_id: 42, share_token: null });
      
      await expect(createShareToken(db, 'book-uuid', 99)).rejects.toThrow('Forbidden');
    });

    it('throws Book not found for missing book', async () => {
      const db = createMockDB(null);
      
      await expect(createShareToken(db, 'nonexistent', 42)).rejects.toThrow('Book not found');
    });
  });

  describe('getShareToken', () => {
    it('returns token for owner', async () => {
      const db = createMockDB({ user_id: 42, share_token: 'my-token' });
      const token = await getShareToken(db, 'book-uuid', 42);
      expect(token).toBe('my-token');
    });

    it('returns null when no token set', async () => {
      const db = createMockDB({ user_id: 42, share_token: null });
      const token = await getShareToken(db, 'book-uuid', 42);
      expect(token).toBeNull();
    });

    it('throws Forbidden for non-owner', async () => {
      const db = createMockDB({ user_id: 42, share_token: 'token' });
      await expect(getShareToken(db, 'book-uuid', 99)).rejects.toThrow('Forbidden');
    });
  });

  describe('revokeShareToken', () => {
    it('sets share_token to NULL for owner', async () => {
      const db = createMockDB({ id: 1, user_id: 42 });
      await revokeShareToken(db, 'book-uuid', 42);
      
      const updateCall = db.prepare.mock.calls[1][0] as string;
      expect(updateCall).toContain('share_token = NULL');
    });

    it('throws Forbidden for non-owner', async () => {
      const db = createMockDB({ id: 1, user_id: 42 });
      await expect(revokeShareToken(db, 'book-uuid', 99)).rejects.toThrow('Forbidden');
    });
  });

  describe('getBookByShareToken', () => {
    it('returns book for valid token', async () => {
      const db = createMockDB({ id: 1, uuid: 'book-uuid' });
      const result = await getBookByShareToken(db, 'valid-token');
      expect(result).toEqual({ id: 1, uuid: 'book-uuid' });
    });

    it('returns null for invalid token', async () => {
      const db = createMockDB(null);
      const result = await getBookByShareToken(db, 'invalid-token');
      expect(result).toBeNull();
    });
  });
});

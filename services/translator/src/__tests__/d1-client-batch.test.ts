import { describe, it, expect, vi, beforeEach } from 'vitest';
import { D1Client } from '../d1-client.js';

const mockConfig = {
  accountId: 'test-account',
  apiToken: 'test-token',
  databaseId: 'test-db',
};

function mockFetchResponse(data: any, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
}

function successResponse() {
  return mockFetchResponse({
    success: true,
    result: [{ results: [], success: true }],
  });
}

describe('D1Client - Batch Operations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('batchInsert', () => {
    it('inserts multiple rows in a single SQL statement', async () => {
      const fetchSpy = successResponse();
      vi.stubGlobal('fetch', fetchSpy);

      const client = new D1Client(mockConfig);
      await client.batchInsert(
        'translations_v2',
        ['chapter_id', 'xpath', 'translated_text'],
        [
          [1, '/p[1]', '你好'],
          [1, '/p[2]', '世界'],
          [1, '/p[3]', '测试'],
        ]
      );

      // Should make a single API call for 3 rows
      expect(fetchSpy).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sql).toContain('INSERT OR REPLACE INTO translations_v2');
      expect(body.sql).toContain('(?, ?, ?), (?, ?, ?), (?, ?, ?)');
      expect(body.params).toEqual([1, '/p[1]', '你好', 1, '/p[2]', '世界', 1, '/p[3]', '测试']);
    });

    it('splits large batches into multiple SQL calls', async () => {
      const fetchSpy = successResponse();
      vi.stubGlobal('fetch', fetchSpy);

      const client = new D1Client(mockConfig);
      const rows = Array.from({ length: 60 }, (_, i) => [1, `/p[${i}]`, `text_${i}`]);

      await client.batchInsert(
        'test_table',
        ['col1', 'col2', 'col3'],
        rows,
        'REPLACE',
        25 // batch size of 25
      );

      // 60 rows / 25 batch = 3 API calls
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('does nothing for empty rows', async () => {
      const fetchSpy = successResponse();
      vi.stubGlobal('fetch', fetchSpy);

      const client = new D1Client(mockConfig);
      await client.batchInsert('test_table', ['col1'], []);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('respects INSERT OR IGNORE conflict mode', async () => {
      const fetchSpy = successResponse();
      vi.stubGlobal('fetch', fetchSpy);

      const client = new D1Client(mockConfig);
      await client.batchInsert(
        'test_table',
        ['id', 'value'],
        [[1, 'a']],
        'IGNORE'
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sql).toContain('INSERT OR IGNORE');
    });

    it('respects INSERT (ABORT) conflict mode', async () => {
      const fetchSpy = successResponse();
      vi.stubGlobal('fetch', fetchSpy);

      const client = new D1Client(mockConfig);
      await client.batchInsert(
        'test_table',
        ['id', 'value'],
        [[1, 'a']],
        'ABORT'
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sql).toContain('INSERT INTO');
      expect(body.sql).not.toContain('OR REPLACE');
      expect(body.sql).not.toContain('OR IGNORE');
    });

    it('handles single row correctly', async () => {
      const fetchSpy = successResponse();
      vi.stubGlobal('fetch', fetchSpy);

      const client = new D1Client(mockConfig);
      await client.batchInsert(
        'translations_v2',
        ['chapter_id', 'xpath', 'translated_text'],
        [[1, '/p[1]', '你好']]
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sql).toContain('(?, ?, ?)');
      expect(body.params).toEqual([1, '/p[1]', '你好']);
    });
  });
});

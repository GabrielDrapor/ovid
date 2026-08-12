import { describe, it, expect } from 'vitest';
import { resumableJobsQuery, RESUMABLE_STATUSES, OWN_BACKEND } from '../job-scanner.js';

describe('resumableJobsQuery backend isolation', () => {
  it('only selects jobs owned by the railway backend', () => {
    const sql = resumableJobsQuery();
    expect(sql).toContain("backend = 'railway'");
  });

  it('keeps the backend filter when extra clauses are appended', () => {
    const sql = resumableJobsQuery("AND updated_at < datetime('now', '-5 minutes') AND book_uuid NOT IN (?)");
    expect(sql).toContain("backend = 'railway'");
    expect(sql).toContain("updated_at < datetime('now', '-5 minutes')");
    expect(sql).toContain('ORDER BY updated_at ASC');
  });

  it('covers all unfinished statuses', () => {
    const sql = resumableJobsQuery();
    expect(RESUMABLE_STATUSES).toEqual(['pending', 'translating', 'extracting_glossary']);
    for (const status of RESUMABLE_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
    // Completed/errored jobs must never be picked up
    expect(sql).not.toContain("'completed'");
    expect(sql).not.toContain("'error'");
  });

  it('declares railway as this service backend identity', () => {
    expect(OWN_BACKEND).toBe('railway');
  });
});

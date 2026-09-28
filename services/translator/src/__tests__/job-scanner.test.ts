import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
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

describe('job creation wiring in index.ts', () => {
  const indexSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
    'utf-8'
  );

  it('always creates jobs owned by railway', () => {
    expect(indexSrc).toMatch(/INSERT INTO translation_jobs[\s\S]*?backend\)/);
    expect(indexSrc).toContain('OWN_BACKEND,');
  });

  it('no longer hands translation off to the Cloudflare Workflow', () => {
    expect(indexSrc).not.toContain('/api/internal/translate-cf');
    expect(indexSrc).not.toContain('triggerCfTranslation');
  });
});

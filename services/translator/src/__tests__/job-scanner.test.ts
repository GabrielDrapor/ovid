import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { resumableJobsQuery, resolveRequestedBackend, RESUMABLE_STATUSES, OWN_BACKEND } from '../job-scanner.js';

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

describe('resolveRequestedBackend', () => {
  it('accepts only an explicit cf', () => {
    expect(resolveRequestedBackend('cf')).toBe('cf');
  });

  it('collapses everything else to railway (old Worker deploys omit the field)', () => {
    expect(resolveRequestedBackend(undefined)).toBe('railway');
    expect(resolveRequestedBackend(null)).toBe('railway');
    expect(resolveRequestedBackend('railway')).toBe('railway');
    expect(resolveRequestedBackend('CF')).toBe('railway');
    expect(resolveRequestedBackend(1)).toBe('railway');
  });
});

describe('cf hand-off wiring in index.ts', () => {
  const indexSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
    'utf-8'
  );

  it('creates jobs with the resolved backend column', () => {
    expect(indexSrc).toContain('resolveRequestedBackend(req.backend)');
    expect(indexSrc).toMatch(/INSERT INTO translation_jobs[\s\S]*?backend\)/);
  });

  it('falls back to railway ownership before translating locally', () => {
    // The fallback must flip job ownership FIRST — a stranded cf job is
    // invisible to the scanner and would never translate
    expect(indexSrc).toContain("SET backend = 'railway'");
    expect(indexSrc).toContain('/api/internal/translate-cf');
  });
});

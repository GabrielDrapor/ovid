/**
 * Query construction for the stalled-job scanner and startup recovery.
 *
 * The backend filter is a hard isolation invariant: this Railway service may
 * only ever resume jobs it owns (backend = 'railway'). Jobs translated by
 * Cloudflare Workflows carry backend = 'cf'; picking one of those up here
 * would mean two writers on the same book, and translations_v2 has no
 * UNIQUE(chapter_id, xpath) constraint to stop the resulting duplicate rows.
 */

/** Job statuses that indicate unfinished work eligible for resume */
export const RESUMABLE_STATUSES = ['pending', 'translating', 'extracting_glossary'] as const;

/** The backend identifier this service owns */
export const OWN_BACKEND = 'railway';

/**
 * Build the SELECT for jobs this service is allowed to resume.
 * `extraWhere` is appended verbatim (e.g. staleness / NOT IN clauses).
 */
export function resumableJobsQuery(extraWhere = ''): string {
  const statuses = RESUMABLE_STATUSES.map((s) => `'${s}'`).join(', ');
  return `SELECT book_uuid, status FROM translation_jobs
     WHERE status IN (${statuses})
     AND backend = '${OWN_BACKEND}'
     ${extraWhere}
     ORDER BY updated_at ASC`;
}

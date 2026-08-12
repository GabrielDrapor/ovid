/**
 * Decides which translation backend a new upload's job belongs to.
 *
 * Rollout order (M2 → M3 of the migration plan):
 *   1. CF_TRANSLATION_ALLOWLIST — comma-separated emails routed to the
 *      Cloudflare Workflow backend (gradual rollout, owner first).
 *   2. CF_TRANSLATION_DEFAULT=1 — every new upload goes to 'cf'
 *      (the M3 flip); the allowlist becomes irrelevant.
 *
 * Anything else — flag unset, email missing or not listed — stays on
 * 'railway'. The choice is recorded on translation_jobs.backend, which is
 * the single source of truth for job ownership (see job-scanner.ts on the
 * Railway side and /api/internal/translate-cf's guard).
 */
export function chooseTranslationBackend(
  userEmail: string | null | undefined,
  env: { CF_TRANSLATION_ALLOWLIST?: string; CF_TRANSLATION_DEFAULT?: string }
): 'railway' | 'cf' {
  const flag = (env.CF_TRANSLATION_DEFAULT ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true') return 'cf';

  if (!userEmail) return 'railway';
  const allowlist = (env.CF_TRANSLATION_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(userEmail.trim().toLowerCase()) ? 'cf' : 'railway';
}

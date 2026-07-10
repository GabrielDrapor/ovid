-- Quality pipeline context for translation jobs (adapted from wenyi,
-- https://github.com/BigDawnGhost/wenyi, MIT):
--   book_context_json    — {styleGuide, synopsis, digests} produced by the
--                          pre-translation scan and injected into every
--                          translation prompt
--   review_summary_json  — per-chapter {issues, fixed} counts from the
--                          chapter-end review pass
-- Note: the CF Worker also applies these via its runMigration() bootstrap;
-- this file exists for manual/local application and documentation.
ALTER TABLE translation_jobs ADD COLUMN book_context_json TEXT;
ALTER TABLE translation_jobs ADD COLUMN review_summary_json TEXT;

-- Which service owns a translation job: 'railway' (current) or 'cf'
-- (Cloudflare Workflows, upcoming). The Railway stalled-job scanner only
-- resumes jobs with backend = 'railway', so two backends can never write
-- the same job concurrently. translations_v2 has no UNIQUE(chapter_id,
-- xpath) constraint, so a dual writer would produce duplicate paragraphs.
ALTER TABLE translation_jobs ADD COLUMN backend TEXT NOT NULL DEFAULT 'railway';

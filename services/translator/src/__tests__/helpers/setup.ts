// Vitest global setup: disable the wenyi-derived quality pipeline features
// by default so legacy tests exercise the baseline pipeline deterministically.
// Tests for the quality pipeline pass PipelineFeatures to translateBook
// explicitly (or call resolveFeaturesFromEnv with a custom env).
process.env.TRANSLATOR_FEATURES = 'off';

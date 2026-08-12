/**
 * translate-book Workflow: durable translation orchestration on Cloudflare.
 *
 * Each chapter is one idempotent step (see translate-core.ts); a sliding
 * window keeps several chapter steps in flight so chapters never serialize
 * at their boundaries. Step retries are kept low (limit 1) because llmChat
 * already retries each LLM call 3× internally — stacking both would
 * amplify 429 storms.
 *
 * Keep this file logic-free: it can't be unit-tested (imports
 * cloudflare:workers), so everything testable lives in translate-core.ts.
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types';
import { D1BindingClient } from './d1-binding-client';
import {
  planTranslation,
  glossaryStep,
  bookTitleStep,
  translateChapterStep,
  finalizeStep,
  markJobError,
} from './translate-core';

export interface TranslateBookParams {
  bookUuid: string;
}

/** Concurrent chapter steps in flight (each runs up to 3 concurrent LLM calls) */
const CHAPTER_WINDOW = 5;

const STEP_CONFIG = {
  retries: {
    limit: 1,
    delay: '15 seconds' as const,
    backoff: 'exponential' as const,
  },
  timeout: '20 minutes' as const,
};

export class TranslateBookWorkflow extends WorkflowEntrypoint<Env, TranslateBookParams> {
  async run(event: WorkflowEvent<TranslateBookParams>, step: WorkflowStep) {
    const { bookUuid } = event.payload;
    const db = new D1BindingClient(this.env.DB);
    const llm = {
      apiKey: this.env.OPENAI_API_KEY,
      baseURL: this.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1',
      model: this.env.OPENAI_MODEL || 'gpt-4o-mini',
    };

    try {
      const plan = await step.do('plan', STEP_CONFIG, () => planTranslation(db, bookUuid));
      if (plan.alreadyCompleted) return { bookUuid, status: 'already-completed' };

      await step.do('glossary', STEP_CONFIG, () => glossaryStep(db, llm, bookUuid));
      await step.do('book-title', STEP_CONFIG, () => bookTitleStep(db, llm, bookUuid));

      // Sliding window of concurrent chapter steps
      const inFlight = new Map<number, Promise<unknown>>();
      const failures: Error[] = [];
      for (const chapterNumber of plan.pendingChapters) {
        while (inFlight.size >= CHAPTER_WINDOW) {
          await Promise.race(inFlight.values()).catch(() => {});
        }
        const p = step
          .do(`chapter-${chapterNumber}`, STEP_CONFIG, () =>
            translateChapterStep(db, llm, bookUuid, chapterNumber)
          )
          .catch((err: Error) => {
            failures.push(err);
          })
          .finally(() => {
            inFlight.delete(chapterNumber);
          });
        inFlight.set(chapterNumber, p);
      }
      await Promise.all(inFlight.values());
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} chapter step(s) failed: ${failures[0].message}`
        );
      }

      await step.do('finalize', STEP_CONFIG, () => finalizeStep(db, bookUuid));
      return { bookUuid, status: 'completed', chapters: plan.pendingChapters.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.do('mark-error', STEP_CONFIG, () => markJobError(db, bookUuid, message));
      throw err;
    }
  }
}

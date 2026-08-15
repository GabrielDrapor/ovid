/**
 * Shared types for Cloudflare Worker
 */
import { OvidDatabase, OvidStorage } from '../platform/types';

export interface Env {
  ASSETS: Fetcher;
  DB: OvidDatabase;
  ASSETS_BUCKET: OvidStorage;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  APP_URL: string;
  OPENAI_API_KEY: string;
  OPENAI_API_BASE_URL?: string;
  OPENAI_MODEL?: string;
  GEMINI_API_KEY?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PUBLISHABLE_KEY: string;
  TRANSLATOR_SERVICE_URL?: string;
  TRANSLATOR_SECRET?: string;
  /** translate-book Workflow binding (Cloudflare Workflows translation backend) */
  TRANSLATE_WORKFLOW: Workflow;
  RESEND_API_KEY?: string;
  /** Comma-separated emails whose uploads translate on the cf backend (M2 gradual rollout) */
  CF_TRANSLATION_ALLOWLIST?: string;
  /** '1'/'true' routes every new upload to the cf backend (M3 flip) */
  CF_TRANSLATION_DEFAULT?: string;
}

export interface User {
  id: number;
  email: string;
  name: string;
  picture: string;
}

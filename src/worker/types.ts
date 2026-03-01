/**
 * Shared types for Cloudflare Worker
 */

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ASSETS_BUCKET: R2Bucket;
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
}

export interface User {
  id: number;
  email: string;
  name: string;
  picture: string;
}

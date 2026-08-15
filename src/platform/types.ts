/**
 * Platform abstraction for the Ovid server.
 *
 * These interfaces are deliberately defined as a *subset* of the Cloudflare
 * D1/R2 shapes the app actually uses. Because TypeScript is structurally
 * typed, `D1Database` and `R2Bucket` satisfy them as-is: the Cloudflare
 * deployment passes its bindings straight through with zero wrapper and zero
 * runtime cost, and no call site has to change. A self-hosted deployment
 * implements the same surface over SQLite and the local filesystem
 * (see src/platform/node/), so handlers stay identical on both runtimes.
 *
 * Keep these interfaces narrow: every method added here is one a self-host
 * adapter must reimplement.
 */

// ---- Database ----

export interface OvidStatementResult<T = Record<string, unknown>> {
  results?: T[];
}

export interface OvidRunResult {
  /** Rows affected — read to distinguish "updated" from "no-op" upserts. */
  meta: { changes?: number };
}

export interface OvidBoundStatement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<OvidStatementResult<T>>;
  run(): Promise<OvidRunResult>;
}

export interface OvidStatement extends OvidBoundStatement {
  bind(...values: unknown[]): OvidBoundStatement;
}

export interface OvidDatabase {
  prepare(sql: string): OvidStatement;
  /** Atomic multi-statement execution (used by the shelf-slot reorder). */
  batch<T = unknown>(statements: OvidBoundStatement[]): Promise<T[]>;
}

// ---- Object storage ----

export interface OvidStoredObjectMeta {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface OvidStoredObject extends OvidStoredObjectMeta {
  body: ReadableStream | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface OvidStorage {
  get(key: string): Promise<OvidStoredObject | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string | null,
    options?: OvidStoredObjectMeta
  ): Promise<unknown>;
  head(key: string): Promise<OvidStoredObjectMeta | null>;
  delete(key: string): Promise<void>;
}

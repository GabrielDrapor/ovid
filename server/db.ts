/**
 * SQLite implementation of OvidDatabase for self-hosted deployments.
 *
 * Uses node:sqlite (built into Node 22+), so a self-host image needs no
 * native module compilation — `docker compose up` never touches a C toolchain.
 * The D1-shaped API is preserved exactly, so handlers are unchanged.
 */

import { DatabaseSync } from 'node:sqlite';
import type {
  OvidBoundStatement,
  OvidDatabase,
  OvidRunResult,
  OvidStatement,
  OvidStatementResult,
} from '../src/platform/types';

/** D1 accepts booleans/undefined; SQLite's binder wants primitives. */
function normalizeParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}

class SqliteBoundStatement implements OvidBoundStatement {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: unknown[]
  ) {}

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(normalizeParams(this.params) as never[]));
    return row === undefined ? null : ({ ...row } as T);
  }

  async all<T = Record<string, unknown>>(): Promise<OvidStatementResult<T>> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...(normalizeParams(this.params) as never[]));
    return { results: rows.map((r) => ({ ...r })) as T[] };
  }

  async run(): Promise<OvidRunResult> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...(normalizeParams(this.params) as never[]));
    return { meta: { changes: Number(info.changes ?? 0) } };
  }
}

class SqliteStatement extends SqliteBoundStatement implements OvidStatement {
  constructor(
    private database: DatabaseSync,
    private statementSql: string
  ) {
    super(database, statementSql, []);
  }

  bind(...values: unknown[]): OvidBoundStatement {
    return new SqliteBoundStatement(this.database, this.statementSql, values);
  }
}

export class SqliteDatabase implements OvidDatabase {
  private db: DatabaseSync;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    // WAL keeps reads from blocking during the long import/translation writes.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  prepare(sql: string): OvidStatement {
    return new SqliteStatement(this.db, sql);
  }

  /** D1's batch is atomic; a transaction gives the same guarantee here. */
  async batch<T = unknown>(statements: OvidBoundStatement[]): Promise<T[]> {
    this.db.exec('BEGIN');
    try {
      const out: T[] = [];
      for (const stmt of statements) {
        out.push((await stmt.run()) as T);
      }
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Run raw DDL (schema bootstrap). Not part of the portable interface. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

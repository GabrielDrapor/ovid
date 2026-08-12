/**
 * D1 binding adapter exposing the same surface as the Railway service's
 * REST D1Client (first/all/run/batchInsert), so the translation core is
 * portable between the two runtimes. Binding calls are same-datacenter and
 * replace the REST client's ~100-300ms HTTP round-trips.
 */

export interface DbClient {
  first<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  batchInsert(
    table: string,
    columns: string[],
    rows: unknown[][],
    onConflict?: 'REPLACE' | 'IGNORE' | 'ABORT'
  ): Promise<void>;
}

export class D1BindingClient implements DbClient {
  constructor(private db: D1Database) {}

  async first<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const row = await this.db.prepare(sql).bind(...params).first();
    return (row as T) ?? null;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.db.prepare(sql).bind(...params).all();
    return (res.results ?? []) as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.db.prepare(sql).bind(...params).run();
  }

  async batchInsert(
    table: string,
    columns: string[],
    rows: unknown[][],
    onConflict: 'REPLACE' | 'IGNORE' | 'ABORT' = 'REPLACE'
  ): Promise<void> {
    if (rows.length === 0) return;
    // Same chunk math as the REST client: stay under 100 bound params/statement
    const maxRowsPerStatement = Math.max(1, Math.floor(100 / columns.length));

    const insertPrefix =
      onConflict === 'REPLACE'
        ? `INSERT OR REPLACE INTO ${table}`
        : onConflict === 'IGNORE'
          ? `INSERT OR IGNORE INTO ${table}`
          : `INSERT INTO ${table}`;
    const colList = `(${columns.join(', ')})`;
    const placeholderRow = `(${columns.map(() => '?').join(', ')})`;

    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < rows.length; i += maxRowsPerStatement) {
      const chunk = rows.slice(i, i + maxRowsPerStatement);
      const placeholders = chunk.map(() => placeholderRow).join(', ');
      const sql = `${insertPrefix} ${colList} VALUES ${placeholders}`;
      statements.push(this.db.prepare(sql).bind(...chunk.flat()));
    }
    await this.db.batch(statements);
  }
}

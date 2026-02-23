/**
 * Cloudflare D1 REST API client
 * Wraps the HTTP API for reading/writing D1 from outside Workers
 */

export interface D1Config {
  accountId: string;
  apiToken: string;
  databaseId: string;
}

export interface D1Result {
  results: Record<string, unknown>[];
  success: boolean;
  meta?: { changes?: number; last_row_id?: number; rows_read?: number; rows_written?: number };
}

export class D1Client {
  private baseUrl: string;
  private apiToken: string;
  private maxRetries = 3;

  constructor(config: D1Config) {
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}`;
    this.apiToken = config.apiToken;
  }

  async query(sql: string, params: unknown[] = []): Promise<D1Result> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/query`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sql, params }),
        });

        if (!res.ok) {
          const text = await res.text();
          // Don't retry on 4xx (except 429)
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            throw new Error(`D1 API error ${res.status}: ${text}`);
          }
          throw new Error(`D1 API error ${res.status}: ${text}`);
        }

        const json = await res.json() as { result: D1Result[]; success: boolean; errors?: any[] };
        if (!json.success || !json.result?.[0]) {
          throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
        }

        return json.result[0];
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 500;
          console.warn(`D1 query retry ${attempt + 1}/${this.maxRetries} in ${delay}ms: ${(err as Error).message}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    throw lastError!;
  }

  async first<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const result = await this.query(sql, params);
    return (result.results[0] as T) ?? null;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.query(sql, params);
    return result.results as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.query(sql, params);
  }
}

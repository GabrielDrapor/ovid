/**
 * D1 REST API client (same pattern as translator service).
 */

interface D1Config {
  accountId: string;
  apiToken: string;
  databaseId: string;
}

export class D1Client {
  private baseUrl: string;
  private apiToken: string;

  constructor(config: D1Config) {
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}`;
    this.apiToken = config.apiToken;
  }

  async execute(sql: string, params: any[] = []): Promise<any[]> {
    const resp = await fetch(`${this.baseUrl}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`D1 API error ${resp.status}: ${text.slice(0, 300)}`);
    }

    const data = (await resp.json()) as any;
    return data.result?.[0]?.results || [];
  }
}

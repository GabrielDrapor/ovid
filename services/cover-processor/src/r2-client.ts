/**
 * Upload to R2 via S3-compatible API using Cloudflare API.
 * We upload via the CF API since we don't have direct R2 S3 creds here.
 */

interface R2Config {
  accountId: string;
  apiToken: string;
  bucketName: string;
  publicBase: string;
}

export class R2Client {
  private config: R2Config;

  constructor(config: R2Config) {
    this.config = config;
  }

  /**
   * Upload a file to R2 via Cloudflare API.
   */
  async put(key: string, data: Buffer, contentType: string): Promise<string> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/r2/buckets/${this.config.bucketName}/objects/${encodeURIComponent(key)}`;

    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': contentType,
      },
      body: data,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`R2 upload error ${resp.status}: ${text.slice(0, 300)}`);
    }

    return `${this.config.publicBase}/${key}`;
  }

  /**
   * Download a file from R2 by its public URL.
   */
  async get(url: string): Promise<Buffer> {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to download ${url}: ${resp.status}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }
}

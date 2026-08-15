/**
 * Filesystem implementation of OvidStorage for self-hosted deployments.
 *
 * Object keys map to paths under a data directory, so backing up a
 * self-hosted install is `tar` on one folder. Metadata (content type,
 * original filename) is kept in a sidecar `.meta.json` next to each object,
 * mirroring R2's httpMetadata/customMetadata.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  OvidStorage,
  OvidStoredObject,
  OvidStoredObjectMeta,
} from '../src/platform/types';

export class FileStorage implements OvidStorage {
  constructor(private root: string) {}

  /** Resolve a key inside the root, rejecting traversal outside it. */
  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    const rootResolved = path.resolve(this.root);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return full;
  }

  private metaPath(filePath: string): string {
    return `${filePath}.meta.json`;
  }

  private async readMeta(filePath: string): Promise<OvidStoredObjectMeta> {
    try {
      const raw = await fs.readFile(this.metaPath(filePath), 'utf8');
      return JSON.parse(raw) as OvidStoredObjectMeta;
    } catch {
      return {};
    }
  }

  async get(key: string): Promise<OvidStoredObject | null> {
    const filePath = this.resolve(key);
    let data: Buffer;
    try {
      data = await fs.readFile(filePath);
    } catch {
      return null;
    }
    const meta = await this.readMeta(filePath);
    const bytes = new Uint8Array(data);
    return {
      ...meta,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer,
    };
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string | null,
    options?: OvidStoredObjectMeta
  ): Promise<unknown> {
    const filePath = this.resolve(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    let buffer: Buffer;
    if (value === null) {
      buffer = Buffer.alloc(0);
    } else if (typeof value === 'string') {
      buffer = Buffer.from(value);
    } else if (value instanceof ArrayBuffer) {
      buffer = Buffer.from(new Uint8Array(value));
    } else if (ArrayBuffer.isView(value)) {
      buffer = Buffer.from(
        value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength
        ) as ArrayBuffer
      );
    } else {
      // ReadableStream — used when copying an object (estimate → upload).
      const chunks: Uint8Array[] = [];
      const reader = (value as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (chunk) chunks.push(chunk);
      }
      buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    }

    await fs.writeFile(filePath, buffer);
    if (options && (options.httpMetadata || options.customMetadata)) {
      await fs.writeFile(this.metaPath(filePath), JSON.stringify(options));
    }
    return undefined;
  }

  async head(key: string): Promise<OvidStoredObjectMeta | null> {
    const filePath = this.resolve(key);
    try {
      await fs.stat(filePath);
    } catch {
      return null;
    }
    return this.readMeta(filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolve(key);
    await fs.rm(filePath, { force: true });
    await fs.rm(this.metaPath(filePath), { force: true });
  }
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { KVStoreInterface } from './translator';

/**
 * File-based KV store for glossary persistence.
 * Stores translations in a JSON file for persistence across script runs.
 * Only available in Node.js environments (not Cloudflare Workers).
 */
export class KVStore implements KVStoreInterface {
  private filePath: string;
  private data: Record<string, string>;

  constructor(filename: string = '.ovid_glossary.json') {
    this.filePath = path.resolve(process.cwd(), filename);
    this.data = this.load();
  }

  private load(): Record<string, string> {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.warn('Failed to load glossary, starting empty:', error);
    }
    return {};
  }

  private save(): void {
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.data, null, 2),
        'utf-8'
      );
    } catch (error) {
      console.error('Failed to save glossary:', error);
    }
  }

  get(key: string): string | null {
    return this.data[key] || null;
  }

  set(key: string, value: string): void {
    this.data[key] = value;
    this.save();
  }

  getAll(): Record<string, string> {
    return { ...this.data };
  }
}

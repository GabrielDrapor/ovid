/**
 * Checkpoint Manager for Translation Pipeline
 * Uses JSONL format for crash-resistant, append-only storage
 *
 * Node.js only - not for Cloudflare Workers
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TranslationResult, ParagraphType } from './types';

export class CheckpointManager {
  private checkpointFile: string;
  private completed: Map<string, TranslationResult>;

  constructor(checkpointFile: string) {
    this.checkpointFile = path.resolve(process.cwd(), checkpointFile);
    this.completed = new Map();
    this.load();
  }

  /**
   * Load existing checkpoint data from JSONL file
   */
  private load(): void {
    try {
      if (!fs.existsSync(this.checkpointFile)) {
        return;
      }

      const content = fs.readFileSync(this.checkpointFile, 'utf8');
      const lines = content.split('\n').filter((line) => line.trim());

      for (const line of lines) {
        try {
          const data = JSON.parse(line) as TranslationResult;
          if (data.id) {
            this.completed.set(data.id, data);
          }
        } catch (e) {
          console.warn(`Skipping invalid checkpoint line: ${line.substring(0, 50)}...`);
        }
      }

      if (this.completed.size > 0) {
        console.log(`   Loaded ${this.completed.size} translations from checkpoint`);
      }
    } catch (error) {
      console.warn('Failed to load checkpoint:', error);
    }
  }

  /**
   * Save a translation result to checkpoint (append to JSONL)
   */
  save(result: TranslationResult): void {
    // Add checkpoint timestamp
    const resultWithTime: TranslationResult = {
      ...result,
      checkpointTime: new Date().toISOString(),
    };

    // Update in-memory map
    this.completed.set(result.id, resultWithTime);

    // Append to JSONL file
    try {
      // Ensure directory exists
      const dir = path.dirname(this.checkpointFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.appendFileSync(this.checkpointFile, JSON.stringify(resultWithTime) + '\n', 'utf8');
    } catch (error) {
      console.error(`Failed to save checkpoint for ${result.id}:`, error);
    }
  }

  /**
   * Check if a paragraph has been translated
   */
  isCompleted(paraId: string): boolean {
    return this.completed.has(paraId);
  }

  /**
   * Get a specific translation result
   */
  get(paraId: string): TranslationResult | undefined {
    return this.completed.get(paraId);
  }

  /**
   * Get all translations as a dictionary (id -> translation)
   */
  getTranslationsDict(): Record<string, string> {
    const dict: Record<string, string> = {};
    this.completed.forEach((result, id) => {
      dict[id] = result.translated;
    });
    return dict;
  }

  /**
   * Get count of completed translations
   */
  getCompletedCount(): number {
    return this.completed.size;
  }

  /**
   * Get all completed results
   */
  getAllResults(): TranslationResult[] {
    return Array.from(this.completed.values());
  }

  /**
   * Clear checkpoint data (both in-memory and file)
   */
  clear(): void {
    this.completed.clear();
    try {
      if (fs.existsSync(this.checkpointFile)) {
        fs.unlinkSync(this.checkpointFile);
      }
    } catch (error) {
      console.warn('Failed to delete checkpoint file:', error);
    }
  }

  /**
   * Get the checkpoint file path
   */
  getFilePath(): string {
    return this.checkpointFile;
  }
}

/**
 * In-memory checkpoint manager for Worker environments
 * Does not persist to disk, only maintains state during translation session
 */
export class InMemoryCheckpointManager {
  private completed: Map<string, TranslationResult>;

  constructor() {
    this.completed = new Map();
  }

  save(result: TranslationResult): void {
    const resultWithTime: TranslationResult = {
      ...result,
      checkpointTime: new Date().toISOString(),
    };
    this.completed.set(result.id, resultWithTime);
  }

  isCompleted(paraId: string): boolean {
    return this.completed.has(paraId);
  }

  get(paraId: string): TranslationResult | undefined {
    return this.completed.get(paraId);
  }

  getTranslationsDict(): Record<string, string> {
    const dict: Record<string, string> = {};
    this.completed.forEach((result, id) => {
      dict[id] = result.translated;
    });
    return dict;
  }

  getCompletedCount(): number {
    return this.completed.size;
  }

  getAllResults(): TranslationResult[] {
    return Array.from(this.completed.values());
  }

  clear(): void {
    this.completed.clear();
  }
}

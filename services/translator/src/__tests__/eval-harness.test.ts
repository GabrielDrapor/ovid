import { describe, it, expect, vi, beforeEach } from 'vitest';
import { translateBook } from '../translate-worker.js';
import { MemoryStore, makeMemoryD1 } from '../../eval/memory-d1.js';

const ALL_ON = {
  styleGuide: true, bookContext: true, incrementalGlossary: true,
  reviewPass: true, autofixSevere: true,
};

const llmConfig = { apiKey: 'k', baseURL: 'https://api.test.com/v1', model: 'm', fastModel: 'f', cheapModel: 'c' };

function bookInput(uuid: string) {
  return {
    uuid, bookId: 100, title: 'Test Book',
    sourceLanguage: 'en', targetLanguage: 'zh',
    chapters: [
      {
        chapter_number: 1, title: 'One', original_title: 'One',
        text_nodes: [
          { xpath: '/p[1]', text: 'Alpha sentence.', html: '<p>Alpha sentence.</p>', orderIndex: 0 },
          { xpath: '/p[2]', text: 'Beta sentence.', html: '<p>Beta sentence.</p>', orderIndex: 1 },
        ],
      },
      {
        chapter_number: 2, title: 'Two', original_title: 'Two',
        text_nodes: [
          { xpath: '/p[1]', text: 'Gamma sentence.', html: '<p>Gamma sentence.</p>', orderIndex: 0 },
        ],
      },
    ],
  };
}

function installLlm() {
  const respond = (content: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const system: string = body.messages[0].content;
    const user: string = body.messages[1].content;
    if (system.includes('pre-translation analyst')) return respond('{"genre":"test","style_guide":["x"]}');
    if (system.includes('summarize novel chapters')) return respond('梗概。');
    if (system.includes('book overview')) return respond('概览。');
    if (system.includes('proper noun extraction')) return respond('{}');
    if (system.includes('proper-noun glossary')) return respond('{}');
    if (system.includes('strict translation reviewer')) return respond('{"issues":[]}');
    if (user.includes('<seg id=')) {
      const ids = [...user.matchAll(/<seg id="(\d+)">/g)].map(m => m[1]);
      return respond(ids.map(id => `<seg id="${id}">译文${id}。</seg>`).join('\n'));
    }
    return respond('译文。');
  }));
}

describe('eval memory-D1 drives the real pipeline', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('runs translateBook end-to-end and collects ordered translations per chapter', async () => {
    installLlm();
    const store = new MemoryStore(bookInput('eval-x'));
    const db = makeMemoryD1(store);

    await translateBook(db, llmConfig, 'eval-x', ALL_ON);

    expect(store.job.status).toBe('completed');
    expect(store.book.status).toBe('ready');

    const ch1 = store.chapterTranslations(1);
    expect(ch1.map(t => t.orderIndex)).toEqual([0, 1]);
    expect(ch1[0].originalText).toBe('Alpha sentence.');
    expect(ch1[0].translatedText).toContain('译文');

    const ch2 = store.chapterTranslations(2);
    expect(ch2).toHaveLength(1);
    expect(ch2[0].originalText).toBe('Gamma sentence.');

    // Book context was produced and stored on the job
    expect(store.job.book_context_json).toBeTruthy();
    const ctx = JSON.parse(store.job.book_context_json);
    expect(ctx.styleGuide.genre).toBe('test');
  });

  it('baseline (features off) still translates every passage', async () => {
    installLlm();
    const store = new MemoryStore(bookInput('eval-b'));
    const db = makeMemoryD1(store);

    await translateBook(db, llmConfig, 'eval-b', {
      styleGuide: false, bookContext: false, incrementalGlossary: false,
      reviewPass: false, autofixSevere: false,
    });

    expect(store.job.status).toBe('completed');
    expect(store.job.book_context_json).toBeFalsy();
    expect(store.chapterTranslations(1)).toHaveLength(2);
    expect(store.chapterTranslations(2)).toHaveLength(1);
  });
});

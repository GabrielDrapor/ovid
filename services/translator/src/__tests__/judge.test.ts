import { describe, it, expect, vi, beforeEach } from 'vitest';
import { judgePair, JUDGE_DIMENSIONS } from '../../eval/judge.js';

const config = { apiKey: 'k', baseURL: 'https://api.test.com/v1', model: 'judge-model' };

/**
 * Mock the judge LLM as a deterministic function of the actual A/B texts, so
 * swapping positions swaps the letter — exactly the position bias the harness
 * must cancel. `preferText` is judged the winner whenever it is present.
 */
function installPositionalJudge(preferText: string, opts: { biasToA?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const user: string = body.messages[1].content;
    const aBlock = user.split('TRANSLATION A:')[1].split('TRANSLATION B:')[0];
    const bBlock = user.split('TRANSLATION B:')[1];
    let winner: 'A' | 'B';
    if (opts.biasToA) {
      winner = 'A'; // always prefers whichever is in position A → position-sensitive
    } else {
      winner = aBlock.includes(preferText) ? 'A' : bBlock.includes(preferText) ? 'B' : 'A';
    }
    const content = JSON.stringify({
      winners: Object.fromEntries(JUDGE_DIMENSIONS.map(d => [d, winner])),
      overall: winner,
      reason: 'ok',
    });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  }));
}

describe('judgePair (blind, order-swapped)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('awards the win to the genuinely preferred variant regardless of position', async () => {
    installPositionalJudge('TREATMENT_TEXT');
    const v = await judgePair(config, 'source', 'BASELINE_TEXT', 'TREATMENT_TEXT', 'en', 'zh');
    expect(v).not.toBeNull();
    expect(v!.overall).toBe('treatment');
    for (const d of JUDGE_DIMENSIONS) expect(v!.dimensionWinners[d]).toBe('treatment');
    expect(v!.positionSensitive).toBe(false);
  });

  it('cancels a pure position bias to a tie and flags it', async () => {
    installPositionalJudge('', { biasToA: true }); // always picks position A
    const v = await judgePair(config, 'source', 'BASELINE_TEXT', 'TREATMENT_TEXT', 'en', 'zh');
    expect(v!.overall).toBe('tie');
    for (const d of JUDGE_DIMENSIONS) expect(v!.dimensionWinners[d]).toBe('tie');
    expect(v!.positionSensitive).toBe(true);
  });

  it('recovers winner labels when the reason breaks JSON (unescaped quote)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            // Invalid JSON: unescaped double-quote inside reason
            content: '{"winners":{"accuracy":"A","fluency":"A","consistency":"tie","style":"A"},"overall":"A","reason":"A says "hello" better"}',
          },
        }],
      }),
    }));
    // Same content both swap runs → A in run1 (baseline=A) and A in run2 (treatment=A)
    // means run1→baseline, run2→treatment → disagreement → tie, but recovery must
    // still have parsed the labels (not dropped the verdict).
    const v = await judgePair(config, 'source', 'BASELINE_TEXT', 'TREATMENT_TEXT', 'en', 'zh');
    expect(v).not.toBeNull();
    expect(v!.positionSensitive).toBe(true);
  });

  it('returns null only when the request itself fails both runs', async () => {
    // llmChat retries 500s with exponential backoff (~7s) before giving up.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'err' }));
    const v = await judgePair(config, 'source', 'a', 'b', 'en', 'zh');
    expect(v).toBeNull();
  }, 20000);
});

# Translation-quality A/B evaluation

This harness answers one question with a concrete number: **did a change to the
translation pipeline make translations better or worse?** Quality is
subjective, so we don't score translations in isolation — we run the pipeline
twice over the same book (baseline vs. a "treatment" feature set) and have a
strong LLM judge do **blind, order-swapped pairwise comparison** of the two
outputs, paragraph by paragraph.

It exercises the **real** `translateBook` pipeline (via an in-memory D1
stand-in, `memory-d1.ts`) — not a re-implementation — so the number reflects
production behavior.

## How bias is controlled

- **Blind** — the judge sees two translations labelled only `A`/`B`; it never
  learns which pipeline produced which.
- **Order-swapped** — every pair is judged twice with A/B positions flipped. A
  variant only wins a dimension if the preference survives the swap; otherwise
  it's a tie. This cancels the position bias LLM judges are known to have. Pairs
  where the two runs disagree are reported as `position-sensitive`.
- **Independent judge** — use a different model for `JUDGE_MODEL` than the
  translator to avoid self-preference.

Dimensions judged: **accuracy, fluency, consistency, style**, plus an overall
winner.

## Running

```bash
cd services/translator

OPENAI_API_KEY=...                         # translator + default judge key
OPENAI_API_BASE_URL=https://api.deepseek.com   # any OpenAI-compatible endpoint
OPENAI_MODEL=deepseek-chat                 # strong tier (translation)
OPENAI_MODEL_FAST=deepseek-chat            # optional: digests/glossary extraction
OPENAI_MODEL_CHEAP=deepseek-chat           # optional: review pass
JUDGE_MODEL=deepseek-reasoner              # stronger, independent judge
EVAL_VARIANT=all \
  npx tsx eval/run-eval.ts [fixture.json]
```

Baseline is always **all features off**. `EVAL_VARIANT` selects the treatment:

| `EVAL_VARIANT`        | Treatment (on top of baseline)                          |
|-----------------------|---------------------------------------------------------|
| `all`                 | every feature on (default)                              |
| `styleGuide`          | pre-translation style analysis only                     |
| `bookContext`         | chapter digests + book synopsis only                    |
| `incrementalGlossary` | per-chapter glossary extraction only                    |
| `reviewPass`          | chapter-end review + severe-issue autofix only          |

Comma-separate to run several treatments against one baseline in one go, e.g.
`EVAL_VARIANT=styleGuide,reviewPass`. This is the **ablation** workflow: it
isolates each wenyi-derived feature so you can see which ones actually move the
number and which are noise on a given book.

## Output

Per-variant win counts and percentages are printed, plus a one-line verdict.
A full report with every per-passage verdict (source, both translations,
per-dimension winners, judge reasons) is written to `eval/results/`.

## Fixtures

`fixtures/scandal-in-bohemia.json` — public-domain (Conan Doyle, 1891) excerpt,
chosen because proper nouns recur across chapters, a character is introduced
mid-story, and a plot device set up in chapter 1 pays off in chapter 3 — so it
stresses glossary consistency, incremental glossary, and book-level
understanding. Add your own fixtures in the same shape and pass the path as the
first argument. Longer, term-dense books show the consistency/glossary features
more than this short excerpt does.

## Interpreting results

- Small fixtures give small samples; treat single-digit win margins as noise.
  Use a longer fixture (more paragraphs) for a tighter signal.
- `consistency` often ties on short books — there aren't enough recurring-term
  conflicts for the glossary features to matter. It separates on long books.
- A dimension where the treatment *loses* is a real finding worth investigating
  (e.g. synopsis context nudging the model toward embellishment hurts accuracy),
  not something to explain away.

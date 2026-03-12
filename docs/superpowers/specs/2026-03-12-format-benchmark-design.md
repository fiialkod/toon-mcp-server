# Format Benchmark Design

Compare JSON, TOON, ASON, and ZON across efficiency (tokens, bytes) and accuracy (round-trip fidelity, LLM comprehension).

## Formats Under Test

| Format | Package | Encode | Decode |
|--------|---------|--------|--------|
| JSON compact | built-in | `JSON.stringify` | `JSON.parse` |
| TOON (pipe) | local `toon.ts` | `encode(data, { delimiter: "\|" })` | `decode(text, "\|")` |
| ASON | `@ason-format/ason` | `new SmartCompressor().compress(data)` | `compressor.decompress(text)` |
| ZON | `zon-format` | `encode(data)` | `decode(text)` |

ASON: use default `SmartCompressor` options (indent: 1, delimiter: `|`, all optimizations enabled).

## File

`benchmark.mjs` in project root. Run via `npm run benchmark`.

Accepts optional flags:
- `--skip-llm` — run only Phase 1 (efficiency + round-trip), no API calls
- `--llm-only` — run only Phase 2 (LLM comprehension)

## Phase 1: Efficiency & Round-trip

For each dataset x format:
1. Encode the data to the format's text representation
2. Measure byte size (`Buffer.byteLength`) and token count (`estimateTokens` from `toon.ts`)
3. Decode back and deep-equal compare to original (recursive key-order-independent comparison, not `JSON.stringify` equality — avoids false negatives from key reordering by ASON/ZON)
4. Record: format, tokens, bytes, savings % vs JSON compact, round-trip pass/fail

If a format throws during encode, record "n/a" for that format x dataset combination.

Note: `estimateTokens` from `toon.ts` is a word-length heuristic, not a real tokenizer. It is applied uniformly across all formats, making relative comparisons fair. Absolute token counts are approximate.

### Output

Per-dataset table:
```
Dataset: medium-tabular (20 rows x 6 fields)
  Format              Tokens   Bytes   vs JSON   Round-trip
  JSON compact           89     312   baseline   PASS
  TOON (pipe)            52     198    -41.6%    PASS
  ASON                   48     185    -46.1%    PASS
  ZON                    45     172    -49.4%    PASS
```

Summary table with averages across all datasets. Results also written to `benchmark-results.json` for programmatic comparison across runs.

## Phase 2: LLM Comprehension

### Setup

Uses Claude API via `@anthropic-ai/sdk`. Requires `ANTHROPIC_API_KEY` env var. Model is parameterized (default: `claude-sonnet-4-20250514`), overridable via `--model` flag.

All API calls use `temperature: 0` for deterministic output. Single trial per question — sufficient for a first-pass benchmark. Acknowledged limitation: small accuracy differences (e.g. 90% vs 93%) may not be statistically significant with this sample size.

Parse flags first, check API key only if Phase 2 will run.

### Method

LLM comprehension questions apply to datasets 1-8 and 10-11 (the ones with enough structure for meaningful questions). Datasets 9 (flat-scalar-array) and 12 (edge-cases) are efficiency-only — they lack structure for retrieval/reasoning questions.

For each applicable dataset, 2-3 pre-defined questions with known correct answers. Two question types:

- **Retrieval**: "What is the email of the user with id 3?" — tests whether Claude can parse and locate specific values
- **Reasoning**: "What is the total price of all items?" / "How many users are active?" — tests whether Claude can aggregate and reason over the data

For each dataset x format x question:
1. Send prompt to Claude:
   ```
   Here is data encoded in {FORMAT} format:

   {encoded_data}

   Question: {question}
   Answer with ONLY the answer value, nothing else.
   ```
2. Compare response to expected answer (case-insensitive, whitespace-trimmed, numeric tolerance for reasoning)
3. Score: correct / incorrect

### Output

```
LLM Comprehension (claude-sonnet-4-20250514)
  Format          Correct   Total   Accuracy
  JSON compact      24/25     96.0%
  TOON (pipe)       23/25     92.0%
  ASON              24/25     96.0%
  ZON               23/25     92.0%
```

Per-question breakdown for any misses.

## Datasets (12)

| # | Name | Shape | LLM questions | Purpose |
|---|------|-------|---------------|---------|
| 1 | small-tabular | 3 rows, 4 fields | yes | Baseline tabular |
| 2 | medium-tabular | 20 rows, 6 fields | yes | Typical API response |
| 3 | large-tabular | 100 rows, 5 fields | yes | Stress test token savings |
| 4 | nested-config | 3 levels deep, no arrays | yes | Non-tabular structure |
| 5 | mixed | Tabular + nested in same object | yes | Real-world combo |
| 6 | single-field | Array of objects with 1 field each | yes | Minimal tabular |
| 7 | deep-nesting | 4+ levels with arrays at each level | yes | Structural complexity |
| 8 | wide-rows | 15+ fields per object | yes | Many columns |
| 9 | flat-scalar-array | Array of numbers/strings | no | Non-object arrays |
| 10 | sparse-irregular | Non-uniform objects (different keys) | yes | Format flexibility |
| 11 | text-heavy | Long string values in tabular rows | yes | String-dominated data |
| 12 | edge-cases | Empty arrays, null values, booleans | no | Corner cases |

Datasets are defined inline in `benchmark.mjs` as a `DATASETS` array of `{ name, data, questions }` objects.

## Questions Per Dataset

Each dataset with LLM questions has 2-3 questions. Examples:

`medium-tabular` (products):
- Retrieval: "What is the price of the product named 'Keyboard'?"
- Retrieval: "What category is the product with id 12?"
- Reasoning: "How many products cost more than $50?"

`nested-config` (config object):
- Retrieval: "What is the database host?"
- Retrieval: "What is the cache TTL value?"

Questions and expected answers are defined alongside each dataset.

## Answer Matching

Answers are compared with tolerance:
- String answers: case-insensitive, trimmed
- Numeric answers: parsed as numbers, tolerance of 0.01
- Boolean answers: case-insensitive "true"/"false"
- If Claude returns extra text around the answer, extract the first number or match substring

## Dependencies

Add to `package.json`:
- `@anthropic-ai/sdk` (dev dependency) for Phase 2

## Error Handling

- Format encode/decode throws: record "n/a", don't crash
- Claude API error: retry once, then record "ERROR" for that question
- Missing `ANTHROPIC_API_KEY`: skip Phase 2, print warning, run Phase 1 only

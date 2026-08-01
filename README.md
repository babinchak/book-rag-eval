# book-rag-eval

A desktop sandbox for designing, comparing, and evaluating retrieval strategies on long-form text. Loads EPUBs through the [Readium Web Toolkit (Go)](https://github.com/readium/go-toolkit), exposes them through a pluggable chunking and retrieval pipeline, and renders chunk boundaries directly on top of the rendered book so retrieval behavior is visible, not just measurable.

## Why

Most RAG tooling is optimized for short documents (chats, tickets, web pages, papers). Books are different: long, narratively structured, full of cross-references, and read non-linearly. The strategies that win on short documents often lose here, and there is no widely shared eval methodology for retrieval over book-length prose.

This project is a workbench for that question. It is built around two ideas:

1. **Strategies are pluggable.** Chunkers, retrievers, summarizers, and rerankers are independent modules that conform to a common interface and can be mixed and matched.
2. **Evaluation is first-class.** A separate eval harness runs strategies against curated Q/A sets per book and reports retrieval-level and answer-level metrics.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Electron Renderer (React + TS)                              │
│   • EPUB reader UI (Readium-rendered xhtml spine)            │
│   • Chunk-boundary overlay                                   │
│   • Strategy picker, query box, retrieval inspector          │
└──────────────────────┬───────────────────────────────────────┘
                       │ IPC
┌──────────────────────┴───────────────────────────────────────┐
│  Electron Main (Node + TS)                                   │
│   • EPUB ingestion via go-toolkit (manifest + spine xhtml)   │
│   • Chunk store, locator index                               │
│   • Spawns and orchestrates the Python sidecar               │
└──────────────────────┬───────────────────────────────────────┘
                       │ HTTP / JSON-RPC over stdio
┌──────────────────────┴───────────────────────────────────────┐
│  Python Sidecar                                              │
│   • Embeddings, vector store, rerankers                      │
│   • Strategy implementations that need the Python ecosystem  │
│   • Eval runner (headless, also runnable from CLI)           │
└──────────────────────────────────────────────────────────────┘
```

Core retrieval, chunking, and eval logic is intentionally kept free of Electron dependencies so it can be lifted into other environments unchanged.

## Canonical document model

EPUB XHTML is normalized once into a versioned, chunker-independent document
artifact. Each spine item contains canonical plain text plus ordered semantic
nodes for headings, paragraphs, lists, blockquotes, footnotes, tables, and
images. Nodes have deterministic IDs, exact character offsets, heading
ancestry, neighboring-node links, DOM source paths, and resolved asset
references.

Chunkers and eval evidence use these canonical offsets. New gold spans also
record their canonical node and book IDs, so changing a chunking strategy does
not redefine the benchmark's source of truth.

Derived chunks, vector indexes, and BM25 indexes are content-addressed. Their
SHA-256 identities include the canonical source/parser, chunker implementation
and parameters, and the relevant index configuration. A parser, source,
embedding-model, dimensions, or tokenizer change therefore creates a distinct
artifact instead of silently reusing stale data.

### Why Python in the loop

Most useful retrieval components — embedding models, rerankers, vector indexes, evaluation tooling — have their canonical implementations in Python. Rather than reimplement or settle for whatever is available in JS, the app ships a Python sidecar that the Electron main process spawns and speaks to over a local transport. The TypeScript side stays in charge of orchestration, storage of locators and chunks, and rendering; Python handles the ML-heavy work and the eval runner.

## Chunk model

Every chunk produced by any strategy carries:

```ts
interface Chunk {
  id: string
  strategyId: string
  spineHref: string // Readium spine item this chunk belongs to
  startLocator: Locator // Readium locator (CFI / progression)
  endLocator: Locator
  text: string
  tokenCount?: number // exact for token-window chunkers
  meta?: Record<string, unknown>
}
```

Locators are what make the visual overlay possible: any retrieved chunk can be projected back onto the rendered page as a highlight, regardless of which strategy produced it.

The default fixed baseline is `1024` tokens with `128` tokens of overlap,
counted with `cl100k_base` to match the current OpenAI embedding models.
Persisted character offsets remain the source of truth for reader highlights
and gold-span evaluation. The older `1200`/`200` character chunker remains
available as a labeled legacy strategy so historical runs stay reproducible.

## Strategies

Strategies are independent and composable. The current axes:

- **Chunking** — fixed-token, sentence, paragraph, semantic, structural (chapter/section), hybrid.
- **Indexing** — dense (multiple embedding models), sparse (BM25), hybrid.
- **Augmentation** — chapter summaries, hierarchical summaries, propositions, HyDE.
- **Retrieval** — top-k, MMR, reranking, parent-document expansion, query rewriting.

Headless experiments also include a deterministic seeded random retriever as
the required lower-bound control; it needs no index or API calls.

Each strategy is a small module that conforms to a common interface and is registered so the UI and the eval harness can discover it.

## Evaluation

The eval harness is independent of the desktop app and runs headless. For each (book, strategy, query set) it reports:

- **Retrieval metrics** — Evidence Efficiency over exact delivered source
  ranges, whole-payload efficiency, Hit@budget, MRR, coverage-aware nDCG,
  required-evidence recall, exact evidence density, and tokens to first/full
  evidence. The standard curve is 512, 1,024, 2,048, 4,096, 8,192, and 16,384
  tokens, with Evidence Efficiency @8,192 as the headline.
- **Evaluation policy** — retrieval is scored deterministically against
  canonical evidence. No LLM judge is required for the retrieval tournament.
- **Operational metrics** — index build latency and storage, p50/p95 online
  retrieval/reranking latency, embedding/reranking tokens, and nominal cost.

Eval sets use a versioned schema. Each case records a stable canonical search
query, within-book or library scope, answerability, dev/test split, difficulty,
tags, provenance, and canonical gold evidence. Evidence can contain multiple
required groups, alternative valid sources, cross-book spans, tables, and
images. Legacy pilot sets are validated and migrated when loaded.

## Status

The six-book development harness is operational. It supports fixed and
structural token chunking; random and BM25 controls; OpenAI and Voyage dense
retrieval; weighted hybrid RRF; Voyage reranking; local ColBERTv2; and BGE-M3
dense, sparse, multi-vector, and hybrid modes. There are separate experiment
lineages for 145 within-book cases and 60 library-wide cases over the same six
books. The library suite includes attributed, source-discovery, and two-book
comparative questions; flat global retrieval is compared with BGE-M3 book
routing at top 1/3/5 and an oracle-book diagnostic. All cases remain explicitly
provisional development data. Human review and a locked test split remain the
release gate before publishing benchmark claims.
The exact holdout procedure is documented in
[`benchmarks/LOCKED_TEST_PROTOCOL.md`](benchmarks/LOCKED_TEST_PROTOCOL.md).

## Stack

- Electron + electron-vite, React 19, TypeScript
- Readium Web Toolkit (Go) for EPUB parsing and locator generation
- Python sidecar for embeddings, retrieval, and eval workloads

## Project setup

```bash
npm install
npm run dev
```

Build:

```bash
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
```

Tests:

```bash
npm test
```

## Headless experiments

Experiment matrices are YAML files validated before any work begins. Start
from [`experiments/smoke.template.yaml`](experiments/smoke.template.yaml), then
run:

```bash
npm run rag-eval -- plan experiments/smoke.yaml
npm run rag-eval -- run experiments/smoke.yaml -- --max-usd 10
npm run rag-eval -- resume experiments/smoke.yaml -- --max-usd 10
npm run rag-eval -- export .rag-eval/runs/<run>.json -- --format jsonl
npm run rag-eval -- export-eval <book-id> <set-id> benchmarks/evals/<set>.json
npm run rag-eval -- sample-evidence benchmarks/corpora/six-book-smoke.json .rag-eval/review.json -- --per-book 25
npm run rag-eval -- report .rag-eval/runs/<run>.json
npm run rag-eval -- tournament .rag-eval/runs/<run>.json -- --budget 8192 --top 12
npm run rag-eval -- generate-library-cases benchmarks/corpora/six-book-smoke.json -- --source-evals .rag-eval/provisional-evals/six-book-smoke-v1 --output-evals .rag-eval/provisional-evals/six-book-library-v1 --run .rag-eval/eval-drafts/six-book-library-cases-v1.json --max-usd 1
npm run rag-eval -- run-library experiments/six-book-library-screen-v1.yaml -- --max-usd 2 --library-dir <library-dir>
npm run rag-eval -- plan-drafts .rag-eval/draft-generation.yaml
npm run rag-eval -- run-drafts .rag-eval/draft-generation.yaml -- --max-usd 5
npm run rag-eval -- retry-draft-failures .rag-eval/eval-drafts/<run>.json -- --max-usd 5 --additional-attempts 2
npm run rag-eval -- audit-drafts .rag-eval/eval-drafts/<run>.json
npm run rag-eval -- compile-drafts .rag-eval/eval-drafts/<run>.json benchmarks/evals/smoke-v1 -- --reviewed-by <name>
npm run rag-eval -- compile-provisional-drafts .rag-eval/eval-drafts/<run>.json .rag-eval/provisional-evals/smoke-v1
```

`plan` reports selected books/cases, missing content-addressed artifacts,
expected query/result counts, embedding tokens, cost, warnings, and the run
fingerprint without creating paid artifacts. `run` refuses unknown prices or a
plan above the dollar ceiling. It journals query results and each experiment
cell atomically, allowing `resume` to continue without repeating completed API
requests. CSV export is also supported.

Set `libraryDir` in the experiment or use
`BOOK_RAG_EVAL_LIBRARY_DIR`/`--library-dir`. For headless paid retrieval, set
`OPENAI_API_KEY` in the environment or copy `.env.example` to the ignored
project-root `.env`; the key is never written to run artifacts.
Voyage retrieval additionally reads `VOYAGE_API_KEY` from the environment.
Embedding spend is metered from provider-reported token usage and journaled by
book, chunk artifact, strategy, and model. Reported dollars are nominal token
cost at the experiment's pinned rate; provider free allowances or account
credits are not observable from an embedding response.

Set `queryModes` to compare the raw user `question` with the fixed diagnostic
`reference` query (`canonicalSearchQuery`). Query rewriting belongs in a future
retrieval pipeline stage and should be cached per case/model/prompt/trial rather
than regenerated for every chunker and context budget.

For portable benchmarks, use `evalSetPath` in experiment YAML and commit the
canonical eval JSON. `evalSetId` remains available for draft sets stored inside
the Electron library.

`sample-evidence` creates a deterministic, chunker-independent authoring packet
from canonical EPUB nodes. It samples across each book and reserves slots for
tables, images, footnotes, lists, and blockquotes when those node types exist.
The first 150-candidate packet is versioned at
`benchmarks/authoring/six-book-smoke-candidates-v1.json`.

`report` writes Markdown and JSON summaries with deterministic 95% bootstrap
intervals, paired evidence-recall deltas, online latency/cost distributions,
and local index build/storage accounting. `tournament` discovers all compatible
completed runs for the target case set and metric version, deduplicates their
strategy cells, and emits a ranked Markdown report, full JSON curves, and an
SVG Evidence Efficiency plot.

`run-library` federates the existing per-book indexes into one searchable
corpus, merges globally ranked candidates, and optionally routes each query to
top-k book profiles before passage retrieval. Library runs have their own case
set and fingerprint, so they never mix with within-book results. Completed base
traces are reused by later reranking experiments; document indexes, embedding
artifacts, and paid query vectors are not rebuilt merely to test a reranker.

Canonical eval drafting is configured from
`benchmarks/authoring/draft-generation.template.yaml`. `plan-drafts` requires
pinned input/output prices but no API key. `run-drafts` journals every metered
attempt, validates exact evidence spans and query leakage, stops before a
request could cross the dollar ceiling, and leaves every case pending human
review. Edit each draft status to `approved` or `rejected`; `compile-drafts`
refuses pending cases or generation failures, revalidates reviewer edits
against the canonical packet, and writes schema-v2 eval sets plus a fingerprinted
manifest.

For exploratory retrieval before review is finished,
`compile-provisional-drafts` validates every generated case against the same
canonical evidence packet but includes pending/revision/rejected cases and
watermarks them as provisional. The tracked
[`experiments/six-book-provisional-baselines.yaml`](experiments/six-book-provisional-baselines.yaml)
runs all 150 drafts through fixed/structural token chunkers, random/BM25
retrieval, both query modes, and three context budgets at zero API cost. These
results are for iteration and must not be presented as a final leaderboard.
The follow-up
[`experiments/six-book-provisional-dense.yaml`](experiments/six-book-provisional-dense.yaml)
compares `text-embedding-3-large` and `voyage-4-large` as vector retrievers and
as equal-weight BM25 hybrids at the standard 4,096-token budget. Document
embedding artifacts are reused between vector and hybrid retrieval.

The Library header's **Benchmark** workspace discovers draft runs in
`.rag-eval/eval-drafts` and headless runs in `.rag-eval/runs`. Its Results
matrix shows cases by chunker/retriever, with selectors for experiment, query
mode, context budget, metric, and book. Clicking a cell opens its exact query,
hit rank, evidence recall, retrieved token count, and chunk IDs. The Case
browser remains available for later human review.
It supports book/status/evidence filters, audit flags, editable questions and
reference queries, exact-evidence highlighting, reviewer notes, and
`approved`/`rejected`/`needs changes` decisions. Review events are journaled in
the draft run, and approval revalidates the edited case against its canonical
evidence. Set `BOOK_RAG_EVAL_ARTIFACTS_DIR` when the artifact directory is not
the project-root `.rag-eval` directory.

Local ColBERTv2/BGE-M3 setup is optional and isolated in an ignored virtual
environment:

```bash
npm run setup:retrieval-python
```

The local indexes are content-addressed under
`.rag-eval/artifacts/local-retrieval`; they can be reused across scoring and
reranking runs without rebuilding.

## License

TBD.

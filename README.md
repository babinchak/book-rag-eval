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

### Why Python in the loop

Most useful retrieval components — embedding models, rerankers, vector indexes, evaluation tooling — have their canonical implementations in Python. Rather than reimplement or settle for whatever is available in JS, the app ships a Python sidecar that the Electron main process spawns and speaks to over a local transport. The TypeScript side stays in charge of orchestration, storage of locators and chunks, and rendering; Python handles the ML-heavy work and the eval runner.

## Chunk model

Every chunk produced by any strategy carries:

```ts
interface Chunk {
  id: string
  strategyId: string
  spineHref: string           // Readium spine item this chunk belongs to
  startLocator: Locator       // Readium locator (CFI / progression)
  endLocator: Locator
  text: string
  meta?: Record<string, unknown>
}
```

Locators are what make the visual overlay possible: any retrieved chunk can be projected back onto the rendered page as a highlight, regardless of which strategy produced it.

## Strategies

Strategies are independent and composable. The current axes:

- **Chunking** — fixed-token, sentence, paragraph, semantic, structural (chapter/section), hybrid.
- **Indexing** — dense (multiple embedding models), sparse (BM25), hybrid.
- **Augmentation** — chapter summaries, hierarchical summaries, propositions, HyDE.
- **Retrieval** — top-k, MMR, reranking, parent-document expansion, query rewriting.

Each strategy is a small module that conforms to a common interface and is registered so the UI and the eval harness can discover it.

## Evaluation

The eval harness is independent of the desktop app and runs headless. For each (book, strategy, query set) it reports:

- **Retrieval metrics** — recall@k, MRR, nDCG against gold passage spans.
- **Answer metrics** — faithfulness and answer relevance via LLM-judge, with the judging prompt and model versioned alongside results.
- **Operational metrics** — latency, token cost, index size.

Q/A sets are authored per book and version-controlled. Each question carries the gold passage span as a Readium locator range so retrieval scoring is exact rather than fuzzy text-match.

## Status

Early. The Electron + React shell and EPUB ingestion via the Readium Go toolkit are in place. Chunk model, strategy interface, Python sidecar wiring, overlay rendering, and the eval harness are next.

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

Python sidecar setup will be documented once it lands.

## License

TBD.

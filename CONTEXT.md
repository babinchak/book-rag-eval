# Context

Glossary of domain terms used in this project. Add a term when it gets pinned down in conversation; revise when meaning shifts.

## Glossary

### Eval case
A single test record: a `question` + a `searchQuery` + one or more `goldSpans`. The same case is used by both retrieval evals and agent evals.

### Question
The natural-language question a user might ask. Used as input to **agent evals** — the agent receives this verbatim and runs its own retrieval + answering loop.

### Search query
A short, realistic search-style query (typically 3–10 words, paraphrased) used as input to **retrieval evals**. Conceptually a *canonical realistic query* — model-agnostic, NOT a snapshot of any particular agent's rewrite. Stays stable across agent changes so the retrieval benchmark stays comparable.

Future: may grow a separate "load from agent" feature that captures what a specific production agent would generate; that would live alongside `searchQuery`, not replace it.

### Gold span
The passage in the book that contains the answer. A case can have multiple gold spans. Used to score whether retrieval surfaced the right region.

### Retrieval eval
Cheap, deterministic eval. Embeds `searchQuery`, runs vector search, scores by whether retrieved chunks overlap any gold span. No LLM call at run time.

### Agent eval
Full eval. Passes `question` to the agent, which does its own query rewrite + retrieval + answer. Scores both retrieval (same as retrieval eval) and citation precision/recall. Costs LLM tokens per case per run.

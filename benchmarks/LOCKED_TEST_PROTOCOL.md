# Locked test release gate

The generated six-book cases currently used by the app are development data.
They are useful for implementation and strategy selection, but every strategy
has now indirectly seen them. They cannot become an honest held-out test set by
changing their `split` field after the fact.

You do not need to audit all development cases before continuing experiments.
Before publishing benchmark claims, use this gate:

1. Freeze the retrieval pipeline schema, metric version, headline budget, and
   candidate-pool rules.
2. Author a new test packet that has never been scored. For the six-book
   portfolio pilot, target 60 text cases (roughly 10 per book). For the eventual
   library benchmark, target 100–200 locked cases across books and difficulty
   bands.
3. Human-review every locked case. Confirm that the question is natural, the
   answer is supported, every required evidence span is complete and exact, the
   scope is correct, and the wording does not leak an implausibly exact search
   phrase. Reject ambiguous cases instead of repairing them after seeing model
   results.
4. Exclude table/image evidence from the text track. Those modalities can be
   added later as separate, explicitly versioned tracks.
5. Compile approved cases with `split: test`, commit the eval files and manifest,
   and record their hashes. Do not tune strategy weights, prompts, chunk sizes,
   or candidate-pool sizes against this split.
6. Run the frozen finalists once. A rerun is allowed only for a documented
   implementation or scoring bug that invalidates the affected run; apply the
   correction consistently to every strategy.
7. Publish the full budget curve, confidence intervals, operational cost, and
   negative results—not only the winning headline number.

Query rewrites, HyDE documents, and multi-query variants are part of a strategy.
Cache them by case, model, prompt version, parameters, and trial seed. The fixed
`canonicalSearchQuery` is a diagnostic oracle/reference query, not a deployable
rewrite result and not the main leaderboard input.

The release gate is therefore “audit every locked test case,” not “audit every
case ever generated.” Development can continue immediately on the provisional
suite.

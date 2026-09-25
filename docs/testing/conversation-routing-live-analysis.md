# Analyze an isolated conversation-routing canary

The [live routing canary](conversation-routing-live-canary.md) prints one final
scalar JSON manifest after its case progress records. Save that final JSON value
without adding private room bundles or provider output. The analysis command is
provider-free: it reads that manifest and optional private human ratings, then
prints only bounded aggregate fields and a deterministic review queue.

```sh
pnpm exec tsx scripts/conversation-routing-live-analysis.ts \
  --manifest /absolute/path/to/scalar-manifest.json \
  --seed pilot-1 --spot-checks 4
```

For a pilot run as several isolated invocations, repeat `--manifest` once per
completed final manifest. The command combines their cases, rejects duplicate
scenario/variant pairs or run IDs, and requires the same source commit, source
digest, OpenCode version, and actor model. Cases paired under one scenario ID
must also agree on participant count, energy, and preflight mode. Different scenario-catalog digests
are retained as a list because each invocation may select different cases.

```sh
pnpm exec tsx scripts/conversation-routing-live-analysis.ts \
  --manifest /absolute/path/to/jev-on.json \
  --manifest /absolute/path/to/jev-off.json \
  --seed pilot-1 --spot-checks 4
```

Use the `scenarioId` and `runId` in each queue entry to locate the corresponding
private bundle retained by the canary. The queue favors low or unassessable
judge results and disagreement with supplied human scores, while reserving one
seeded sample when at least two checks are requested and an otherwise ordinary
case exists. This is a review-selection aid, not a quality verdict.
If no judge results are present, the queue is empty; review the template rows
directly instead.

Generate an **unrated** template from the same manifest:

```sh
umask 077
pnpm exec tsx scripts/conversation-routing-live-analysis.ts \
  --manifest /absolute/path/to/scalar-manifest.json --template \
  > /absolute/private/directory/human-ratings.json
```

The template has `schemaVersion: 1` and one `{ "scenarioId": "...",
"runId": "..." }` row per completed trigger. Edit only cases actually reviewed.
For each metric, either omit it (not yet rated), set
`{ "status": "not_assessable" }` when the visible content cannot support a
judgment, or set `{ "status": "not_applicable" }` when the scenario has no such
obligation. Rated fields are:

| Field | Rated shape | Review question |
| --- | --- | --- |
| `directReply` | `{ "status":"rated", "expectedTargets":1, "missedTargets":0, "humanCorrection":false }` | Did each clearly addressed agent provide a useful reply, and did the human have to correct a miss? Use `not_applicable` without a direct target. |
| `naturalness` | `{ "status":"rated", "score":4 }` | Did the exchange read like responsive group chat? Score 1 (poor) through 5 (strong). |
| `distinctValue` | `{ "status":"rated", "assessedReplies":2, "valuableReplies":1 }` | How many visible agent replies added distinct useful substance? |
| `replyWaste` | `{ "status":"rated", "assessedReplies":2, "unnecessaryReplies":1, "duplicateReplies":0 }` | How many visible replies were unnecessary or repeated another reply? The two counts may overlap. |
| `handoff` | `{ "status":"rated", "correct":true }` | When a person needed to decide or supply input, did the room leave that floor with them? |
| `closure` | `{ "status":"rated", "correct":true }` | Did the room stop after resolution and avoid premature or redundant continuation? |

Each rated reply-count metric needs at least one assessed visible reply. A
private `privateNote` of at most 1,000 characters may help the reviewer record
their reasoning; the parser drops it before analysis. Do not paste prompts,
model output, links, or credentials into any other field. Keep the rating file
and retained bundles outside the repository in a private directory, then remove
them when review is finished. The scalar report never includes a note or room
text.

To include human judgments:

```sh
pnpm exec tsx scripts/conversation-routing-live-analysis.ts \
  --manifest /absolute/path/to/scalar-manifest.json \
  --ratings /absolute/private/directory/human-ratings.json \
  --seed pilot-1 --spot-checks 4
```

The report labels automated judge findings `judgeOnly` and human findings
`humanRated`, with separate rated, missing, not-applicable, and not-assessable
denominators. `humanReviewCoverage` counts unsubmitted runs as missing for each
metric, while `humanRated` summarizes only submitted ratings. It matches Jev-on
and Jev-off runs only when the fictional `scenarioId` and settings match.

The actor's OpenCode step-finish cost is a **local estimate**, not a provider
billing record. Its token fields are OpenCode-observed normalized usage, not
independently provider-reported usage. Jev's `reportedCostUsd` comes from its
provider response when present. The report labels their sum
`actorEstimatedPlusJevReportedCostUsd`; it is mixed-provenance cost, not actual
room spending. The token comparison labels its derived sum
`openCodeObservedTotalPlusJevPromptCompletionTokens`. Actor uncached input is
shown separately and is never called total input. Jev-off has a structural zero
classifier cost because it did not consult Jev. Judge spending appears
separately and is never included in room-turn cost.

Paired mixed-cost and token comparisons require explicit OpenCode step-field
provenance and complete field coverage on **both** runs. Older scalar manifests
may contain normalized fallback zeros that look reported; they are labeled
`legacy-unverified`, excluded from those comparisons, and shown only as
diagnostic amounts. `judgeOnly.naturalnessAndMixedCost` and
`humanRated.naturalnessAndMixedCost` use only quality-rated pairs with complete
mixed-cost coverage. Their `naturalnessAndObservedTokens` counterparts use only
quality-rated pairs with complete OpenCode observed totals and Jev
prompt/completion counts. Each comparison reports its own denominator. A
missing judge or human rating is never a favorable score. These small
stochastic pairs show observations and review priorities, not causal savings or
what an uninvoked agent would have said.

The analysis command rejects unknown manifest fields and oversized input. It
does not invoke the room server, OpenCode, Jev, or the judge model. An incomplete
or failed canary's progress records are not a substitute for its final manifest;
record their failure categories separately rather than inventing a completed
run for analysis.

## Four-axis A/B study analysis

For a completed study using `--judge-rubric v2`, repeat `--manifest` for the
final scalar manifest from each invocation. The same provider-free command
prints `conversation-routing-live-study-analysis`; `--template` creates a
private `schemaVersion: 2` human-rating template. Each row has a `scenarioId`,
`runId`, and empty `axes` object. Review the retained private fictional bundle
for that row while blinded to arm, profiles, cost, and judge scores. Fill any
of `social_cadence`, `length_fit`, `address_radius`, and `contribution_value`
with `{ "status": "rated", "score": 1 }` through score 5, or with
`{ "status": "not_applicable" }` or `{ "status": "not_assessable" }`.
An omitted axis remains missing. Optional `privateNote` is discarded by the
parser. Keep ratings and bundles private and outside the repository.

Use the four-axis rubric independently:
social cadence covers visible text rhythm and social cues, not measured
latency; length fit penalizes too-short and too-long exchanges; address radius
judges the appropriate audience among the user and agents rather than the
number of agent-to-agent turns; contribution value can be useful knowledge or
fitting entertainment. A required direct reply with no visible answer is a
too-short length failure. Quiet casual cases may be not assessable. Without a
reference, neither judge nor human rating verifies factual truth.
For an optional latest prompt with no agent reply, the length judge may rate
the silence with reason `silence_fit` and direction `too_short` or
`appropriate`; the parser rejects that reason for required replies, visible
replies, and the other three axes.

| Axis | Score 1 | Score 3 | Score 5 |
| --- | --- | --- | --- |
| Social cadence | Flat, tone-deaf, or disruptive turn rhythm | Coherent but ordinary | Context-sensitive and smoothly responsive |
| Length fit | Requested answer omitted or exchange rambles | Minor length mismatch | Sufficient and concise |
| Address radius | Wrong recipient or human decision usurped | Mixed or ambiguous audience | Clearly addresses the people this scenario calls for |
| Contribution value | Filler or repetition | Some relevant value | Distinct useful knowledge or fitting entertainment |

The study report lists cases, block/replicate pairs, and triggers separately;
multi-trigger arcs carry earlier conversation history and are correlated.
`byFactor` reports Jev-question, gate, and agent-prompt comparisons separately.
Each block also carries its own paired readout. Arm B minus arm A judge and human
score differences remain separate for each axis; actor estimated cost, Jev
reported cost, judge reported cost, OpenCode-observed total tokens, and first
visible latency each have their own paired denominator. A missing value or
unrated axis reduces only its corresponding denominator. There is no pooled
quality or resource effect across different factors.
Each axis has its own rated, not-applicable, not-assessable, missing, and failed
denominators. Human-versus-judge agreement reports status agreement across
joint reviews and exact/within-one score agreement only for jointly rated
axes. Arm B minus arm A differences use matching plan, source, model settings,
roster order, factor profiles, and trigger ordinal. Known resolved Jev model
mismatches or missing resolved identity in both-consulted pairs exclude those
trigger comparisons. Failed, skipped, or absent Jev-on consultation remains in the
completion/coverage counts and its trigger pair is excluded from arm-difference
estimates. Judge score pairs also require matching resolved judge
models. Actor provider-resolved identity is unavailable and never inferred.
The report has no composite score or causal claim. Actor estimated cost,
Jev-reported cost, judge-reported cost, OpenCode-observed tokens, and measured
latency remain separate, each with its own coverage. Old v1 manifests retain
their original analysis path and cannot be mixed into a v2 study.

`resources.judgeReportedAxisCostUsd` sums every judge-axis cost actually
reported, including axes from triggers whose other judge outcomes lack cost.
It gives the total axis denominator, reported axes, confirmed deterministic
no-call axes, and axes with unresolved cost. Its sum is a reported subtotal,
not a full bill when an attempted or unknown call lacks reported usage.
`resources.judgeReportedCostUsd` still requires all four axis costs on a
trigger; paired judge-cost comparisons use only those complete triggers.

The deterministic review queue prioritizes failed, unassessable, low-scored,
or human-discordant axes and includes a seeded ordinary control when possible.
Use the same seed and independently review queued private bundles before
interpreting apparent score differences. Inspect disagreement by axis and
record the number of reviewed and unreviewed cases; a missing human judgment
is never counted as agreement or a favorable rating.

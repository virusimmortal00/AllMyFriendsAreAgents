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
metric, while `humanRated` summarizes only submitted ratings. It matches Jev-on and Jev-off runs only when the fictional
`scenarioId` is the same. Actor plus Jev token and cost comparisons require
fully reported usage on **both** sides; absent usage stays null. Jev-off has a
structural zero classifier cost because it did not consult Jev. Judge spending
appears separately and is never treated as room turn cost. A missing judge or
human rating is not a favorable score. The `judgeOnly.naturalnessAndReportedCost`
field uses only pairs with both rated judge naturalness and fully reported
actor-plus-Jev cost, so its quality and cost deltas have the same denominator.
`humanRated.naturalnessAndReportedCost` applies the same paired rule to human
scores when they are available.
The separate token and cost totals retain their own reported and missing run
counts. These small stochastic pairs show
observations and review priorities, not causal token savings or a measurement
of what an uninvoked agent would have said.

The analysis command rejects unknown manifest fields and oversized input. It
does not invoke the room server, OpenCode, Jev, or the judge model. An incomplete
or failed canary's progress records are not a substitute for its final manifest;
record their failure categories separately rather than inventing a completed
run for analysis.

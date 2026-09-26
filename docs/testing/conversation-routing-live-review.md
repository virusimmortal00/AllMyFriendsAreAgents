# Private offline conversation review

The live study can retain fictional conversations for a human spot check. The
review pack presents one conversation at a time without disclosing the study
arm, profile, model cost, or model-judge scores. It is a **private local file**:
never commit the HTML, source bundles, locator map, queue, exports, or converted
ratings. Read the [live canary guide](conversation-routing-live-canary.md) for
the isolated run and retained-bundle setup.

Create an empty directory outside the repository with `0700` permissions.
Supply **every finalized batch manifest** with a repeated `--manifest` and each
batch's private bundle directory with a repeated `--source-dir`. The CLI uses
the strict canary parser and complete-batch merger; it rejects missing,
overlapping, incompatible, or duplicate cases. It also rejects missing or
duplicate source bundles. All created private files have `0600` permissions.
Pass the same manifests in the same batch order on every command, since the
private locator pins that exact collection. For an already completed plan,
use its previously fixed `studyPlan.planSha256` as the selection seed; for a
future study, fix the seed before reviewing outcomes.

```bash
pnpm exec tsx scripts/conversation-routing-live-review.ts blind \
  --manifest /PRIVATE/batch-1.json --manifest /PRIVATE/batch-2.json \
  --source-dir /PRIVATE/batch-1-review --source-dir /PRIVATE/batch-2-review \
  --output-dir /PRIVATE/blinded-review

pnpm exec tsx scripts/conversation-routing-live-review.ts select-calibration \
  --manifest /PRIVATE/batch-1.json --manifest /PRIVATE/batch-2.json \
  --map /PRIVATE/blinded-review/blinded-map.json \
  --seed PLAN_SHA256 --output /PRIVATE/calibration-queue.json \
  --receipt /PRIVATE/calibration-selection.json

pnpm exec tsx scripts/conversation-routing-live-review.ts pack \
  --manifest /PRIVATE/batch-1.json --manifest /PRIVATE/batch-2.json \
  --queue /PRIVATE/calibration-queue.json --map /PRIVATE/blinded-review/blinded-map.json \
  --blinded-dir /PRIVATE/blinded-review/blinded \
  --source-dir /PRIVATE/batch-1-review --source-dir /PRIVATE/batch-2-review \
  --review-set calibration \
  --output /PRIVATE/calibration.html

pnpm exec tsx scripts/conversation-routing-live-review.ts select-flagged \
  --manifest /PRIVATE/batch-1.json --manifest /PRIVATE/batch-2.json \
  --map /PRIVATE/blinded-review/blinded-map.json \
  --calibration-receipt /PRIVATE/calibration-selection.json \
  --seed PLAN_SHA256 --output /PRIVATE/flagged-queue.json \
  --receipt /PRIVATE/flagged-selection.json

pnpm exec tsx scripts/conversation-routing-live-review.ts select-visible \
  --manifest /PRIVATE/batch-1.json --manifest /PRIVATE/batch-2.json \
  --map /PRIVATE/blinded-review/blinded-map.json \
  --calibration-receipt /PRIVATE/calibration-selection.json \
  --seed PLAN_SHA256 --output /PRIVATE/visible-queue.json \
  --receipt /PRIVATE/visible-selection.json

pnpm exec tsx scripts/conversation-routing-live-review.ts pack \
  --manifest /PRIVATE/batch-1.json --manifest /PRIVATE/batch-2.json \
  --queue /PRIVATE/visible-queue.json --map /PRIVATE/blinded-review/blinded-map.json \
  --blinded-dir /PRIVATE/blinded-review/blinded \
  --source-dir /PRIVATE/batch-1-review --source-dir /PRIVATE/batch-2-review \
  --review-set visible-enriched --output /PRIVATE/visible.html
```

Open the HTML locally in a browser. Review each card on its own merits. The
four independent axes are social cadence, length fit, address radius, and
contribution value. Each shows 1, 3, and 5 anchors; intermediate scores may be
used. `NA` records an explicit judgment that the axis is not assessable.
`Clear` leaves it unrated. The page marks when no agent reply is visible after
the latest human prompt. It does not measure latency; rate text cadence only.
Use Tab and the visible controls, `1`–`5` or `N` on a focused axis, and
Alt+Left/Right to change cards. Export partial ratings before closing the page;
there is no browser storage. Import a prior export to resume. An import with
unknown or duplicate review IDs, an invalid score, or a changed pack
fingerprint is rejected without replacing current ratings.

The explicit download contains only opaque review IDs, axis ratings, and a
fingerprint. Convert it privately using the locator map and original bundles:

```bash
pnpm exec tsx scripts/conversation-routing-live-review.ts convert \
  --manifest /PRIVATE/batch-1.json --manifest /PRIVATE/batch-2.json \
  --queue /PRIVATE/calibration-queue.json --map /PRIVATE/blinded-review/blinded-map.json \
  --blinded-dir /PRIVATE/blinded-review/blinded \
  --source-dir /PRIVATE/batch-1-review --source-dir /PRIVATE/batch-2-review \
  --ratings /PRIVATE/blinded-ratings.json --output /PRIVATE/human-ratings.json
```

The converted `schemaVersion: 2` ratings file is accepted by the [analysis
CLI](conversation-routing-live-analysis.md). Conversion checks the exact
selected source text again and refuses changed or ambiguous files. The pack
has a restrictive content security policy, no external assets or network
requests, no forms, and renders conversation text as text rather than HTML.

Choose and record the calibration seed before inspecting model judgments or
reply outcomes. `select-calibration` uses the seed and study design only: it
selects 12 distinct pairs (four per changed factor), covers each available
agent-count stratum, then selects one trigger ordinal per pair. Both arms are
included. The resulting 24 cards are shuffled and paired cards separated;
the private selection receipt records pair IDs and strata but neither the
HTML nor rating export contains them. Selection fails if the factor/agent-count
coverage is insufficient. This balanced calibration sample is **not** a
population estimate or a full evaluation of long arcs. A multi-trigger block
has no complete human A/B block delta unless every ordinal in both arms is
rated.

`select-flagged` is a separate, outcome-conditioned inspection set: up to one
additional paired trigger per factor where a required target had no visible
reply. It excludes an identical pair/ordinal already in calibration. The
private receipt lists factors without an additional eligible trigger. If none
are eligible, no queue file is created. To review the flagged queue, use the
same `pack` command with that queue and a distinct HTML output. Convert its
ratings separately. Keep flagged ratings and their denominator separate from
the seed-only calibration sample; do not combine them into an unbiased quality
estimate. The older `select` command remains available for intentionally
judge-prioritized spot checks, not for the calibration sample.

`select-visible` creates a separate **visible-response enriched** inspection
set for judge calibration. Both arms must have a visible delivered agent reply
at the chosen trigger. The selector excludes an identical pair/ordinal already
in calibration and chooses 10 distinct pairs by seed: two agent-prompt, four
optional-gate, and four Jev-question pairs. It prefers blocks outside
calibration but may use a different ordinal from a calibration block when
necessary. Insufficient eligible pairs fail closed. Its 20 blinded cards keep
counterparts apart, and the private receipt records the outcome-conditioned
selection. The HTML heading identifies the set. Convert its ratings with the
same command using the visible queue and distinct output paths. Keep its
ratings and denominator separate from calibration and flagged inspection.
This enriched set is not a prevalence estimate or an unbiased quality sample.

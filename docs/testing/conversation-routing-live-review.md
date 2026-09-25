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

```bash
pnpm exec tsx scripts/conversation-routing-live-review.ts blind \
  --manifest /PRIVATE/batch-1.json --manifest /PRIVATE/batch-2.json \
  --source-dir /PRIVATE/batch-1-review --source-dir /PRIVATE/batch-2-review \
  --output-dir /PRIVATE/blinded-review

pnpm exec tsx scripts/conversation-routing-live-review.ts select \
  --manifest /PRIVATE/batch-1.json --manifest /PRIVATE/batch-2.json \
  --map /PRIVATE/blinded-review/blinded-map.json \
  --seed fictional-review-seed --pairs 12 --output /PRIVATE/blinded-queue.json

pnpm exec tsx scripts/conversation-routing-live-review.ts pack \
  --manifest /PRIVATE/batch-1.json --manifest /PRIVATE/batch-2.json \
  --queue /PRIVATE/blinded-queue.json --map /PRIVATE/blinded-review/blinded-map.json \
  --blinded-dir /PRIVATE/blinded-review/blinded \
  --source-dir /PRIVATE/batch-1-review --source-dir /PRIVATE/batch-2-review \
  --output /PRIVATE/review.html
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
  --queue /PRIVATE/blinded-queue.json --map /PRIVATE/blinded-review/blinded-map.json \
  --blinded-dir /PRIVATE/blinded-review/blinded \
  --source-dir /PRIVATE/batch-1-review --source-dir /PRIVATE/batch-2-review \
  --ratings /PRIVATE/blinded-ratings.json --output /PRIVATE/human-ratings.json
```

The converted `schemaVersion: 2` ratings file is accepted by the [analysis
CLI](conversation-routing-live-analysis.md). Conversion checks the exact
selected source text again and refuses changed or ambiguous files. The pack
has a restrictive content security policy, no external assets or network
requests, no forms, and renders conversation text as text rather than HTML.

`select` samples both arms at the same trigger ordinal, stratifies by study
factor and agent count, and puts paired cards apart in a seeded blind order.
It prioritizes low, failed, unassessable, or discordant model judgments while
retaining ordinary controls. A 12-pair/24-card selection samples **one trigger
ordinal per selected pair**. It supports trigger-level human calibration and
spot checking; a multi-trigger block has no complete human A/B block delta
unless every ordinal in both arms receives a rating. Do not describe this
sample as a full human evaluation of long arcs or a causal estimate.

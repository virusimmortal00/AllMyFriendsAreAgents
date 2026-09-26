# Conversation judge sensitivity probe

The live conversation study uses four independent quality graders and a fifth
room-frame grader. A uniformly high score can mean the conversations were good
or that a grader missed obvious defects. This small calibration probe tests the
second possibility before interpreting study scores.

`scripts/conversation-routing-judge-calibration-fixtures.ts` contains seven
fictional normal/degraded pairs. Each pair calls **only its assigned grader**
on both responses: social cue and cadence fit, answer length, audience fit,
useful content, explicit room-frame rejection, another agent amplifying a
frame rejection, or an ordinary planning preface versus explicit hidden-instruction
narration. These are obvious controls, not a representative conversation
sample or a replacement for human ratings. The quality graders use their
existing `room-quality-v2` prompts; both frame probes use the existing
`room-frame-integrity-v1` prompt. The probe does not generate agent responses,
alter routing, or change a study plan.

Preview the closed labels, score thresholds, rubric digest, and 14-call budget
without credentials or provider calls:

```bash
pnpm exec tsx scripts/conversation-routing-judge-calibration.ts \
  --dry-run \
  --actor-model openrouter/anthropic/claude-haiku-4.5 \
  --judge-model google/gemini-3.8-flash
```

For a paid probe, first create a private directory, then use the workstation's
secret launcher. The report path must be absolute and new; the directory must
have mode `0700`. The command makes at most 14 sequential judge calls, with no
retry. Each individual request retains the existing judge's 30-second cap.

```bash
mkdir -m 700 "$HOME/.codex/issue-232-judge-calibration"
bws-run pnpm exec tsx scripts/conversation-routing-judge-calibration.ts \
  --allow-paid \
  --actor-model openrouter/anthropic/claude-haiku-4.5 \
  --judge-model google/gemini-3.8-flash \
  --output "$HOME/.codex/issue-232-judge-calibration/report.json"
```

The `0700` directory and `0600` report stay outside the repository. The report
contains only closed labels, scalar ratings, frame flags, failure categories,
call counts, a digest of the fixture and grader source, and provider-reported
cost when every call supplies it. Missing cost remains `null`, never zero.
Neither provider message bodies nor fictional conversation text are copied into
the report. Do not publish a raw provider transcript or a private report.

A probe passes when its normal control scores at least 4, the degraded control
scores at most 2 (at most 3 for the subtler social-cue control), and their gap
meets the fixture threshold. Frame controls additionally require the expected
rejection/amplification flags. An unrated or failed call fails that probe. Use
`rows[].failures` to identify possible ceiling effects and inspect the
corresponding synthetic control before changing a rubric. Passing these seven
controls is only evidence that the graders detect these clear defects; it does
not establish agreement with human ratings on real conversations.

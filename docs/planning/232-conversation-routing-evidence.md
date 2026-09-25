---
id: conversation-routing-evidence
status: active
issue: 232
updated: 2026-09-25
---

# Outcome

Room turn-taking gives a clearly addressed participant a chance to answer,
keeps bounded spontaneous participation, and stops when useful conversation is
settled. Provider calls and latency are measured alongside participant value.
The room-level `off`, `shadow`, and `enforce` modes govern initial-message
preflight only; they do not revert follow-up, settlement, or attempt limits.

# Acceptance and evidence

| Check | Current reproducible evidence | Remaining evidence |
| --- | --- | --- |
| Clear human addresses and multi-addresses require healthy named agents; ambiguous names do not | `shared/direct-address-fixtures.ts`, `shared/direct-address.test.ts`, and `server/preflight-gate.test.ts` cover conservative prose and canonical mention precedence. Low advisory scores cannot veto a clear address. Unavailable targets are reported as unavailable. | Human review of real-room missed addresses and corrections. |
| Required targets survive discretionary turn scheduling | Enforced turns carry `preflight.required`; the scheduler's focused tests distinguish required and optional turns across energy levels. Off remains a literal bypass; shadow keeps its counterfactual behavior. | Manual room check for a named agent at each energy setting. |
| Direct agent follow-ups differ from quotation, attribution, recap, comparison, and model/product references | The shared fixture corpus and follow-up tests exercise positive invitations and negative references. | Human review of ambiguous phrasing in ordinary conversations. |
| Resolved exchanges avoid unnecessary synthesis; unresolved disagreements remain eligible; BLOCKED hands off | Focused conversation tests cover final-state synthesis and handoff decisions. | Manual casual, settled, blocked, and genuine-disagreement checks; broader #149 safety-pause presentation remains open. |
| Ownership-related yields avoid retrying the same unrelated fallback; ordinary questions can get a natural acknowledgment | Focused conversation tests exercise yield and conversational-floor behavior. | Annotated unnecessary or duplicate replies in live rooms; broader #147 follow-up calibration remains open. |
| Energy bounds optional participation and preserves required turns | Shared `CONVERSATION_OPTIONAL_SEATS` drives preflight and scheduling; party energy retains ambient participation. | Human judgment of distinct ambient contributions by energy setting. |
| Room turn attempts have their own ceiling | Conversation tests cover attempted-turn admission separately from visible-message and responding-turn limits. Each admitted turn can use the existing bounded runner retry after a stale result. | Observe terminal reasons and provider usage under normal operation. OpenCode-internal steps are outside this room-turn ceiling; this is not a strict provider-call bound. |
| Jev has one complete provisional 1,000 ms deadline and no retries | Classifier timeout/recovery tests cover request, parse, validation, and late responses. | Measure fallback rate and latency before changing deadline or adding a retry. |
| Per-trigger observability is privacy-safe | Focused observability tests cover classifier categories, preflight/fallback, queue delay, attempts, terminal reason, usage/cost when reported, and first visible response. | Check bounded aggregate completeness in a room; keep prompts, raw output, private URLs, and credentials out. |
| UI truthfully indicates queued and deciding activity | `src/reconnect-flow.test.tsx` covers queued, deciding, typing precedence, terminal cleanup, and reconnect replacement. Fictional Chromium/WebKit browser fixtures capture `CHAT-01` and `CHAT-02` within a complete 786-image matrix. | The current full-matrix image review stopped after 81/786 images because of an unrelated baseline-identical failure; affected chat images outside that reviewed subset, native-device behavior, and deployed-room timing remain unverified. |

# Provider-free fixture evaluation

Run `pnpm exec tsx scripts/evaluate-routing-evidence.ts` to evaluate the shared
fictional address corpus. Its output counts expected target obligations,
obligations the recognizer misses, and agents it would incorrectly require.
The corpus makes explicit regression judgments; it is not a representative
sample of live language or a measure of an uninvoked agent's possible reply.
The evaluator also replays the address signals from repository commit
`6ad3215`: human preflight has no plain-name required signal when canonical
mentions, structured targets, and high classifier scores are absent; agent
follow-ups match any roster name in visible text. The comparison assumes
exactly those fixture conditions and counts signals, not scheduled or invoked
provider turns. It does not estimate a baseline quality or token outcome.

The same command accepts one optional path to a **sanitized** JSON file with at
most 500 per-trigger rows and a 512 KB file limit. The input contains agent IDs
and counts, never message text, prompts, provider output, credentials, or
participant identity. For example:

```json
{
  "schemaVersion": 1,
  "triggers": [
    {
      "expectedDirectAgents": ["agent-example"],
      "requiredAddressAgents": ["agent-example"],
      "attemptedTurns": 1,
      "yieldedTurns": 0,
      "respondingTurns": 1,
      "distinctAmbientContributions": 0,
      "missedDirectReplies": 0,
      "unnecessaryReplies": 0,
      "duplicateReplies": 0,
      "humanCorrection": false,
      "inputTokens": 120,
      "outputTokens": 45,
      "costUsd": 0.001,
      "firstVisibleMs": 900
    }
  ]
}
```

`expectedDirectAgents`, distinct ambient contributions, missed direct replies,
unnecessary replies, duplicate replies, and human correction require explicit
human annotation; omitting an annotation leaves its aggregate unmeasured.
`requiredAddressAgents` contains only agents required by an address signal,
excluding broadcast or structured-task ownership. It and
attempted/yielded/responding turns, provider-reported tokens/cost, and latency
come from observed routing and generation records. Missing provider usage or
first-visible timing remains null rather than zero. `missedRequiredSelections`
counts an expected direct target absent from required routing; it does not
claim that an agent would have replied if invoked. `missedDirectReplies` is a
separate explicit human judgment. The fixture evaluator makes no claim about
baseline provider-turn outcomes or live quality.

For future sanitized exports, the `generation-completed` activity stage carries
`generationId`, `attemptOrdinal`, and `providerReportedCostUsd`. The existing
GenerationJournal records `providerUsage` and `providerCostUsd` under the same
`generationId`. Join those records inside the authorized local room boundary,
then export only bounded numeric aggregates for this evaluator. It does not
perform that join or treat estimated tokens as provider-reported usage.

# Rollout and next action

Collect bounded per-trigger aggregates and annotated corrections before
tuning thresholds or energy limits. Compare direct-target misses, distinct
ambient contributions, unnecessary and duplicate replies, attempted/yielded
calls, reported tokens/cost, and first-visible latency. Analyze denominator
and missing annotations with each rate. A regression in address coverage or
conversation quality caused by initial-message gating warrants placing the
affected room in `shadow` or `off` while inspecting sanitized decisions.
Follow-up, settlement, and attempt-policy regressions require a separate code
fix or revert. No automatic promotion or policy change follows from the
fictional fixture pass.

Authorized isolated live checks used fresh rooms and two configured agents.
They recorded aggregate routing and generation events without retaining prompt
or output text. The check used OpenCode 1.18.25 with
`openrouter/anthropic/claude-haiku-4.5`, one concurrent generation, and a
120-second scenario watchdog. The direct-address case used its own fresh room;
the next four cases shared a separate isolated room, so recent-thread affinity
in the casual case reflects that sequence. The separate-role disagreement case
used another fresh room.

| Scenario | Observed routing and result | Attempted / responding / yielded | First visible | Legacy stream input / output tokens; cost |
| --- | --- | ---: | ---: | ---: |
| Direct address, low energy | Named target required; other suppressed; one visible reply; `no-explicit-unresolved-state` | 1 / 1 / 0 | 5,201 ms | 2 / 29; $0.00999075 |
| Whole-room invitation, low energy | Both required by `explicit_broadcast`; two visible replies | 2 / 2 / 0 | 5,452 ms | 4 / 185; $0.01543295 |
| Casual message, balanced energy | One agent eligible through recent-thread affinity, then yielded; no visible reply or synthesis; `no-visible-output` | 1 / 0 / 1 | unavailable | 2 / 20; $0.0082272 |
| Named-human handoff, low energy | Named target required, one visible BLOCKED reply, second agent not started; `blocked-input` | 1 / 1 / 0 | 6,137 ms | 2 / 217; $0.0125097 |
| Disagreement, low energy | Both required; one visible OPEN reply, other yielded; `open-without-second-responder`, no synthesis | 2 / 1 / 1 | 6,560 ms | 4 / 192; $0.02501565 |
| Separate-role disagreement, low energy | Both required and both yielded; no visible reply or synthesis; `no-visible-output` | 2 / 0 / 2 | unavailable | 4 / 40; $0.01468545 |

The six earlier no-Jev-credential room checks in this table predate the
explicit OpenCode step-field provenance marker. Their normalized stream token
and cost values are diagnostic only:
missing step fields could have been filled with zero, the input/output figures
exclude cached usage, and the actor cost is an OpenCode estimate rather than a
provider bill. They are separate from the twelve-case live Jev pilot below and
excluded from complete token or cost comparisons. All
classifier consultations skipped with `no_credential` in the isolated
environment and used deterministic fallback, so these runs do not validate
Jev quality or latency. The disagreement samples never produced two visible
respondents, leaving synthesis eligibility untested live. The casual yield
shows a quiet outcome, not a human judgment of conversational naturalness.
These checks do not establish token savings or broader quality calibration.
Earlier diagnostic attempts with a 90-second watchdog and log-filename or
credential/argument setup defects were excluded from these acceptance results
because their timelines could not be interpreted reliably. Temporary room state
was cleaned, and the disposable fixture project was unchanged.

## Isolated live pilot

Twelve additional isolated room cases were exercised across source epochs,
not twelve comparable manifests. Their first six exploratory live cases
included Jev-on and Jev-off configurations: Jev completed in some, and some
received automated judge ratings. Their actor-usage fields lack verifiable
step-field presence, so those legacy-unverified amounts cannot enter complete
token or cost comparisons. One later two-agent
broadcast case ran at source commit `7f3b61a`; its room turn completed, but its
original judge call failed, so it is not a matched quality comparison. A
subsequent judge-only call on its retained fictional output produced a scalar
rating without rerunning the room. The final five room cases ran at clean
source commit `525baec` with the same OpenCode version, actor model, and source
digest. They comprise a two-agent broadcast pair, a three-agent disagreement
pair with a second resolution trigger in each room, and one three-agent casual
case. Only the three Jev-on/off trigger pairs from this final epoch enter the
comparisons below.

All paired cases used `enforce` preflight, with low energy for broadcast and
lively energy for disagreement and resolution. Jev-on consultations completed;
Jev-off skipped consultation by design. In the three-agent case, Jev classified
named targets as required on the disagreement and resolution triggers. The
deterministic recognizer on Jev-off did not mark those two address constructions
as required, although optional scheduling still invoked participants. Thus the
observed routing difference is a required-target decision, not proof that an
off-mode participant would never answer.

| Matched trigger (one pair each) | Judge naturalness, on / off | First visible, on / off | Responding turns, on / off | OpenCode-observed total + Jev prompt/completion tokens, on / off | Actor-estimated + Jev-reported cost, on / off |
| --- | ---: | ---: | ---: | ---: | ---: |
| Broadcast, two agents | 5 / 1 | 6,821 / 12,003 ms | 2 / 1 | 16,162 / 15,612 | $0.014381048 / $0.015494 |
| Disagreement, three agents | 5 / 3 | 9,694 / 12,138 ms | 2 / 2 | 25,051 / 23,752 | $0.021869010 / $0.020988750 |
| Resolution, three agents | 4 / 4 | 6,251 / 9,643 ms | 2 / 2 | 34,952 / 33,218 | $0.015923998 / $0.015627550 |

Across these **three matched trigger pairs**, judge-only naturalness averaged
4.67/5 with Jev and 2.67/5 without; first visible output was 3,673 ms sooner
with Jev on average. Each run attempted the same number of turns as its pair;
the broadcast Jev-off run yielded once, while both variants of each
three-agent trigger responded twice and yielded once. The combined observed
token sums were 76,165 on and 72,582 off. The mixed-provenance cost sums were
$0.052174056 on and $0.052110300 off. These sums include Jev's API-reported
tokens and cost only on the on side; OpenCode's actor tokens are normalized
step-finish observations, and its cost is a local pricing estimate. The
independent judge's API-reported cost is separate from both room-turn sums.
All six paired triggers have complete OpenCode-observed total-token and actor
estimate coverage, complete applicable Jev usage, and judge ratings.

The unmatched three-agent casual case consulted Jev, attempted one turn, yielded,
and showed no visible reply. The judge marked naturalness **not assessable**;
missing visible output is not a favorable zero or a human naturalness finding.
No human ratings have been submitted for the seven final-epoch triggers. A
deterministic private spot-check queue selects low-scored and seeded cases for
human review. The named disagreement trigger ended with
`no-material-disagreement`, so no live case yet proves continuation after a
genuine unresolved dispute. These small stochastic, judge-rated observations
do not establish a causal quality or savings effect. The reproducible isolated
runner and provider-free multi-manifest analysis commands, including the
private human-rating workflow, are documented in
[`docs/testing/conversation-routing-live-canary.md`](../testing/conversation-routing-live-canary.md)
and
[`docs/testing/conversation-routing-live-analysis.md`](../testing/conversation-routing-live-analysis.md).

A provider-free Chromium/WebKit full visual capture passed 636 browser cases
with 36 matrix skips and produced 786/786 screenshots (run `IE02C0`, all
geometry assertions passing). Its manifest records head commit `1ade35f`,
`dirty: true`, and input digest
`fbb744c7e09c69fb12ca1fe19d92c1e8761916cc629325edb94200057608a088`.
Commit `a4592a6` subsequently recorded a focused UI correction; the capture
manifest itself does not attest a clean checkout of that commit or equivalence
to its tree.
The capture command was `pnpm capture:visual --workers 4`.
It covers 42 registered view IDs; nine registered legacy workspace IDs
(`WORK-01`–`WORK-09`) are not captured. The earlier incomplete run
(`q6o5TF`, 750/786) exposed two deterministic failures at every matrix
checkpoint: General inherited 16px text instead of the property-sheet's 12px,
and a disclosure keyboard test assumed its initial state was open. Those are
corrected in the complete capture, along with the independently reproduced
model-picker Back visibility and stale administration navigation test.

The first account-backed independent review attempt used explicit model
`gpt-6-sol` against the complete capture and failed closed before any verdict:
the installed Codex CLI's ChatGPT endpoint reported that model unsupported.
The review has 0/786 image judgments. A fresh attempt with the runner's
documented account-model default reviewed 48 images; two Room behavior Phone
images failed proportion, scroll/actions, and outcome because of an unstyled
fieldset frame and nonpersistent form actions. That review was stopped with
its verdicts retained. The UI was revised and a second full capture (`s0Rgm5`)
passed 636 browser cases with 36 matrix skips and 786/786 screenshots. Its
manifest records head `a4592a6`, `dirty: true`, and input digest
`91cfd85c2d0731803b1736cd1d7ce24a35346bf3f5a970be1c84b685c391ddf6`.
A bounded four-image independent review passed all seven questions for the
revised Chromium Phone Room behavior top and bottom. Chromium Minimum-phone
summarizer picker top and bottom failed screen use, proportion, empty area,
scroll/actions, and outcome because search and results did not share a useful
visible area; those verdicts remain retained. A narrower picker-only layout
correction passed focused Chromium and WebKit browser checks. An intermediate
complete capture (`ufJaSd`) again produced 786/786 screenshots; its four-image
independent smoke passed Room behavior top/bottom but failed Minimum-phone
picker top/bottom on remaining horizontal framing. Those failed verdicts are
retained. That manifest records head `a4592a6`, `dirty: true`, and input digest
`ea7ab89b2fc60c278061805fdae0df17f58826f7b1c473f999515a07d88a3b1c`.
A further scoped width correction passed focused browser checks, and
the final complete capture (`G3I8Ms`) passed 636 browser cases with 36 matrix
skips and 786/786 screenshots. Its manifest records head `a4592a6`,
`dirty: true`, and input
digest `1a8a2984d40d9e6660cdf9326d9420d830d4f79103ed5fec8597d063e1b1d16e`;
commit `02459d3` subsequently recorded that UI source and visual-test change.
A fresh independent four-image smoke passed all seven questions for the same
Phone behavior and Minimum-phone picker top/bottom images. A new full-matrix
account-backed review then recorded 81/786 image judgments and 27 completed
session receipts before it was stopped at the first independent failure. One
Chromium Phone Manage Agents empty-roster image failed screen use, empty area,
and outcome because of large blank bands around its onboarding card. Its image
SHA-256 is
`f46dcadb3e516ee50129f4620a07e99f5ad7e6d2105c59f5a9d40e56b3f3d873`
in `IE02C0`, `s0Rgm5`, and `G3I8Ms`, showing that exact image predates the
current Room behavior and picker correction. No change to Manage Agents was
made as part of this issue. `pnpm check:visual-review` failed for incomplete
coverage and that retained image verdict; the remaining 705 images have no
judgment in this review. The complete matrix therefore has **no visual
approval**. `pnpm run check:quality` passes 241 suites and 1,952 tests (one
intentional skip) after the UI correction, including the responsive-view audit
contract. Native-device behavior remains unverified.

# Evidence

- [Issue #232](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/232)
- `shared/direct-address-fixtures.ts`, `shared/direct-address.test.ts`
- `server/preflight-gate.test.ts`, `server/conversation.test.ts`, `server/intent-classifier.test.ts`
- `scripts/evaluate-routing-evidence.ts`, `scripts/evaluate-routing-evidence.test.ts`
- `src/reconnect-flow.test.tsx`, `tests/visual/app.visual.ts`

# Open questions

- Which ambiguous conversational phrasings should become required after human
  review rather than remain ambient candidates?
- What measured fallback and quality rate would justify one retry within the
  same classifier deadline?

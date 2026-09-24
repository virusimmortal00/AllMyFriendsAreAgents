---
id: conversation-routing-evidence
status: active
issue: 232
updated: 2026-09-23
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
| UI truthfully indicates queued and deciding activity | `src/reconnect-flow.test.tsx` covers queued, deciding, typing precedence, terminal cleanup, and reconnect replacement. Fictional browser fixtures capture `CHAT-01` and `CHAT-02`. | Independent image review of the exact capture; native-device behavior and deployed-room timing remain unverified. |

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

Manual room checks for direct address, whole-room invitation, casual banter,
human handoff, and genuine disagreement remain pending; no live or paid
provider call is part of this record.

A focused fictional browser capture of affected chat states passed 42 images
across Chromium and WebKit. The attempted full visual capture did not complete:
Chromium Short phone could not keep the model picker's Back action in view at
the bottom, and Chromium Tablet's administration recovery flow timed out
waiting for an Agent behavior tab. Both reproduced in isolated provider-free
scenarios. These are current failures in separate views; their cause relative
to this change has not been established. Independent image review remains
pending, and the affected-view capture is not full-matrix approval.

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

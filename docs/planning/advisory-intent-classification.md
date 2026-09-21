---
id: advisory-intent-classification
status: active
issue: 92
owner: unclaimed
reviewers: []
depends_on: [energy-aware-preflight-invocation-gating]
reported_by: virusimmortal00
updated: 2026-09-18
---

# Outcome

Each room agent learns, before any model tokens are spent, whether the latest
human message is actually directed at them. A dedicated intent classifier
(TypeSafe AI's System One model Jev, routed through the room's existing
OpenRouter connection via `https://openrouter.ai/api/alpha/decisions`, model
alias `~typesafe/jev-latest`) advises the existing deterministic pre-flight
gate so that clearly irrelevant invocations never reach prompt construction,
while deterministic signals (mentions, structured targets, explicit
invitations) always remain authoritative. The classifier is enabled by
default; administrators disable it per-room in Server Administration → Room behavior → Agent Routing, and a
server-owned environment kill switch disables it everywhere. Routing evidence
records the classifier's cost, latency, and per-agent probabilities together
with a no-classifier baseline decision, so the pre/post impact on cost and
response time is measurable from recorded data without a second mandatory
model call.

# Acceptance checks

- [x] A server-side classifier consult sends the bounded, redacted recent-room
  transcript (same visibility, disclosure, and agent-text redaction rules as
  agent-facing transcripts) plus one typed question per enabled agent; it never
  receives private (human-recipient) transcripts.
- [x] The consult is advisory only. Without an API key, on any transport or
  parse failure, and during a bounded failure cooldown, routing is byte-for-byte
  the decision the deterministic gate would have produced.
- [x] A high classified address probability (`classifiedAddressThreshold`, 0.75
  by default) adds an unmentioned agent as a required participant with the
  `classified_addressed` reason; a canonical mention or structured target always
  outranks it.
- [x] A low classified address probability (`classifiedIrrelevantThreshold`,
  0.15 by default) removes an agent from ambient and fallback candidacy and
  reports `classified_irrelevant`; an agent the classifier did not score is
  treated as unclassified, never as irrelevant.
- [x] The gate still selects exactly one fallback responder when every healthy
  agent is classified irrelevant, so a classifier verdict alone never produces
  a room with zero responders.
- [x] A high classified whole-room probability (`classifiedWholeRoomThreshold`,
  0.7 by default) selects every healthy agent exactly like an explicit
  invitation.
- [x] Each classified decision persists the consult metrics (model, latency,
  input/output tokens, cost, per-agent probabilities) and the deterministic
  baseline decision in the bounded pre-flight audit store, sanitized on read.
- [x] Invoked-agent dispositions now carry provider-reported cost and
  wall-clock duration when available, for both speak and yield outcomes.
- [x] Routing evidence exposes aggregate classification counters: calls,
  tokens, cost, average latency, additional suppressions and invocations,
  suppressed agents that spoke or yielded, rescued invocations that spoke, and
  counterfactual saved cost and duration summed only over turns that actually
  ran with reported metrics.
- [x] Classification never runs in pre-flight mode `off`; the off-mode bypass
  is unchanged.
- [x] Classifier diagnostics log model, latency, token counts, and error
  messages only; message text and credentials never appear in logs.
- [x] The configured classifier endpoint must use HTTPS before a transcript or
  authorization credential can be sent.
- [x] Legacy JSON rooms that predate `preflightMode` persist an explicit `off`
  migration value; only newly created rooms default to `enforce`.
- [x] Classification context ends at the selected human trigger, and a room
  activity change while the consult is pending cancels the stale routing job.
- [x] Aggregate evidence reports `mixed` instead of mislabeling multi-model
  totals with a single model identifier.
- [x] Focused unit tests cover fail-open paths (no key, HTTP failure, malformed
  answers, cooldown), gate composition, persistence round-trips, and the
  evidence aggregate.

# Current state

Implemented on the `jev-intent-classifier` branch in an isolated worktree. The
classifier consult lives in `server/intent-classifier.ts`; `server/index.ts`
constructs it from the room's existing OpenRouter credential
(`readOpenRouterApiKey`, the same file OpenCode itself reads — no separate
TypeSafe key exists or is needed) plus optional
`ALL_MY_FRIENDS_ARE_AGENTS_INTENT_CLASSIFIER_MODEL`/`_ENDPOINT` overrides and
the `ALL_MY_FRIENDS_ARE_AGENTS_INTENT_CLASSIFIER_DISABLED` kill switch. It is
consulted inside `preflightTurns` only when a room's pre-flight mode is
`shadow` or `enforce` and the room's `intentClassifierEnabled` setting (Server
Administration → Room behavior → Agent Routing, default on, SQLite migration 0030) is true. The
pure gate consumes only a probabilities-only projection; the audit store
persists the full consult, including OpenRouter-reported `usage.cost`. The
pre-flight audit store gained optional fields that normalize away for older
records. Its endpoint override is HTTPS-only. Classifier context is bounded at
the selected trigger message and activity-revision checks cancel a stale route
when a newer room message arrives during a consult. JSON rooms that were saved
before pre-flight modes retain `off`; aggregate evidence reports `mixed` when
its totals contain more than one resolved classifier model.

Pre-flight mode defaults to `enforce`: new rooms gate invocations from birth,
with the classifier advising the deterministic gate. Rooms with a persisted
`off`/`shadow` configuration keep their setting and can change it at any time
in Server Administration → Room behavior → Agent Routing; the previous shadow-evidence promotion gate (200 decisions
or seven days, sub-5% false-suppression rate) was removed by owner decision on
2026-09-18 in favor of immediate enforce-by-default. Shadow mode remains
available for any room that wants measurement without suppression.

Verified against the live OpenRouter Decisions API on 2026-09-18: a direct
`~typesafe/jev-latest` consult returned Noul probabilities, the resolved model
`typesafe/jev-1.13-20260917`, OpenRouter-reported cost, and ~0.4s latency.
Classification quality over sustained traffic remains unmeasured; the evidence
surface records false suppressions and counterfactual savings so the decision
can be revisited with data.



# Decision model

```ts
interface PreflightClassificationSignal {
  agents: Partial<Record<AgentId, number>>; // P(directly addressed), 0-1
  wholeRoom: number;                        // P(invites everyone), 0-1
}
```

The classifier returns typed probabilities, not prose, so the gate maps them
onto three deterministic thresholds rather than parsing text. Multi-addressing
("A and B, what do you think?") is representable because per-agent
probabilities are independent; a single-choice router could not express it.

# Rollout evidence

Enforcement ships by owner decision without a shadow soak: the false-
suppression risk was accepted in exchange for immediately eliminating the
measured silent-turn waste (#92: 52.2% of a week's generations, ~65.9M of
102.6M tokens). Every enforced decision still records the consult (model,
latency, tokens, cost, per-agent probabilities) and, in shadow mode, the
no-classifier baseline; dispositions carry per-turn provider cost and
duration. The aggregate `classification` block in `/api/preflight/evidence`
shows both sides — `counterfactualSavedCostUsd`/`DurationMs` (gross savings)
and `suppressedSpoke` (false suppressions) — so the owner decision can be
reversed per room with data if the false-suppression rate proves material.
Suppressed agents still never advance their delta cursor, so a false
suppression loses no context: the agent catches up verbatim-or-summarized on
its next invocation.

# Next action

Watch the classification evidence after merge: false-suppression tallies,
counterfactual savings, and classifier cost/latency. Tune the
0.75/0.15/0.7 thresholds or revert a room to `shadow`/`off` if the data
warrants.


# Evidence

- Classifier client: `server/intent-classifier.ts` and
  `server/intent-classifier.test.ts`
- Gate thresholds and reasons: `server/preflight-gate.ts` and
  `server/preflight-gate.test.ts`
- Audit persistence and aggregate: `server/preflight-store.ts`,
  `server/preflight-store.test.ts`, `shared/preflight.ts`
- Wiring: `server/index.ts` (`preflightTurns`, `classifyTrigger`, disposition
  metrics), `server/transcript.ts` (`classificationTranscript`)
- Configuration: `.env.example` (`ALL_MY_FRIENDS_ARE_AGENTS_INTENT_CLASSIFIER_*`)
- OpenRouter Decisions API:
  `https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request`
  (`POST /api/alpha/decisions`, Noul/Choice/Score primitives; model
  `~typesafe/jev-latest`, $0.042/MTok input, output free)
- Baseline waste motivating the work: #92's 2026-08-27 generation-journal
  sample (52.2% of 3,376 generations silent; ~65.9M of 102.6M tokens)

# Open questions

- Should the classifier also score follow-up turns (issue #147's
  referential-vs-direct address problem), or stay limited to initial
  human-message fan-out until #147 lands its fixture corpus?
- Are the 0.75/0.15/0.7 thresholds right for this room's tone? They are gate
  configuration, not model behavior; the shadow soak should tune them.

---
id: energy-aware-preflight-invocation-gating
status: active
issue: 92
owner: unclaimed
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-27
---

# Outcome

The room avoids clearly irrelevant agent invocations without flattening natural group-chat participation. Explicit social signals guarantee consideration, conversation energy controls how many additional agents may naturally join, and every invoked agent has a machine-readable, minimal-cost way to yield without leaking internal narration into chat.

# Acceptance checks

## Conservative zero-token selection

- [x] Add a deterministic, side-effect-free preflight decision function and a separate state holder for durable routing counters.
- [x] Run preflight before `buildPrompt()` or any OpenCode invocation for initial human-message fan-out.
- [x] A suppressed agent causes no prompt construction, provider session mutation, model call, token usage, or delta-cursor advancement.
- [x] An explicit agent `@mention` always selects that healthy agent for consideration, but does not force a visible response and does not automatically exclude ambient reactions from other agents.
- [x] An explicit whole-room invitation selects every healthy enabled agent.
- [x] An explicit room action uses its canonical targets and bypasses ordinary human-message heuristics.
- [ ] A canonical reply target selects the agent that owns the replied-to message once reply metadata exists; adjacency alone is never treated as reply ownership.
- [ ] A task assignee is a required participant only when the trigger carries canonical task, assignment, or continuation context relevant to that assignment.
- [ ] Explicit exclusion cues represented by trusted routing metadata can suppress excluded agents; the gate does not invent exclusions from ambiguous prose.
- [x] If an ordinary human message has no required or soft-pass participant, select exactly one healthy fallback agent using deterministic room ranking.
- [x] Provider cooldown, authentication failure, unavailable models, disabled roster entries, and other health failures are reported as unavailable rather than misclassified as preflight suppression.

## Conversation energy and ambient participation

- [x] Treat hard passes as required participants and all other socially eligible agents as an ambient pool.
- [ ] Use recent active-thread participation, cross-agent addressing, quietness, and deterministic rotation to rank the ambient pool.
- [x] Keep tag affinity entirely outside preflight until the tagging feature ships a canonical metadata contract; never infer tag affinity from message prose.
- [x] Do not require a positive routing rule for every ambient participant; under uncertainty, preserve a bounded chance for a natural side reaction.
- [x] Apply these initial ambient-seat defaults unless room settings explicitly override them:
  - `low`: required participants, or one fallback when none are required; no additional ambient seat.
  - `balanced`: required participants plus at most one ambient seat.
  - `lively`: required participants plus at most three ambient seats.
  - `party`: all socially eligible participants may be selected, bounded by existing safety ceilings.
  - explicit whole-room invitation: all healthy enabled participants are selected regardless of the ambient-seat limit.
- [x] Keep follow-up mentions, objections, synthesis, and other conversation-engine turns governed by their explicit turn targets; do not rerun initial-message preflight heuristics over them.
- [x] Preserve the existing ordering and instructions byte-for-byte when preflight mode is `off`.

## Minimal invoked-agent yield

- [x] Give every invoked agent a machine-readable disposition with `speak` and `yield` outcomes.
- [x] A yielded turn emits no transcript message and cannot leak a prose explanation or `NO_RESPONSE_NEEDED` marker into chat.
- [x] A yield uses a bounded reason enum such as `not_addressed`, `another_agent_owns_this`, `already_covered`, `no_distinct_contribution`, or `conversation_settled`.
- [x] Human-facing text for a yield reason is derived by the application rather than generated as free-form internal reasoning.
- [x] A speaking disposition retains the existing bounded message count, conversation state, style update, and investigation-request behavior.
- [x] Malformed disposition output fails closed as a silent turn and remains available only in the existing sensitive generation journal for diagnosis.

## Anti-starvation without forced awkwardness

- [x] Persist per-agent routing counters used by the pure decision function so restart does not silently reset selection history.
- [x] Count only ordinary, untargeted human-chat triggers toward ambient starvation; direct mentions, explicit actions, presence events, system status, and task-specific messages do not penalize unrelated agents.
- [x] Increase a long-silent agent's ambient rank before forcing a probe.
- [x] At the configured threshold, select at most one starved agent for an eligible socially open trigger, with deterministic tie-breaking by roster order and trigger message ID.
- [x] Record an anti-starvation selection in routing activity and audit data, never as a transcript status message.

## Auditability and safe rollout

- [x] Support room modes `off`, `shadow`, and `enforce`; the default at merge is `off`.
- [x] In `shadow`, calculate and record the decision but preserve current invocation behavior so hypothetical false suppressions can be measured.
- [x] Store a bounded, sanitized routing decision keyed by a decision ID and trigger message ID; suppressed agents have no fabricated generation ID.
- [ ] Record per-agent outcomes and stable reason codes including required mention, explicit broadcast, explicit action target, recent-thread affinity, ambient selection, fallback, anti-starvation probe, no routing signal, and unavailable.
- [x] Provide a retrospective projection that can compare shadow suppression decisions with actual `speak` or `yield` results without exposing prompts, raw provider output, reasoning parts, credentials, or provider session IDs.
- [x] Make bounded aggregate retrospective evidence—including rates, denominators, and reason-code tallies—visible to every room participant.
- [x] Restrict raw per-trigger and per-agent routing decisions to room owners and administrators, consistent with the sensitive generation-journal boundary.
- [x] Count a shadow-suppressed `speak` result as distinct unless deterministic transcript evidence establishes that it duplicates already-visible content; ambiguity counts against promotion rather than in favor of enforcement.
- [x] Make a room eligible for explicit promotion from `shadow` to `enforce` after either 200 completed shadow suppression decisions or seven days of recorded shadow traffic, whichever occurs first.
- [x] Require an observed false-suppression rate below 5% over the recorded would-suppress decisions before promotion; no evaluable suppression denominator is not a passing result.
- [x] Never switch modes automatically when the evidence threshold is reached; a room-level authorized decision remains required.
- [x] Keep routing activity out of the room transcript and out of future agent context.
- [ ] Permit an owner/admin diagnostic activity UI to distinguish `not selected`, `selected`, `considered and yielded`, `responded`, and `unavailable` without claiming that an uninvoked agent thought about the message.
- [ ] A participant-visible activity surface may show active or completed invoked-agent dispositions, but never reveals the raw per-trigger suppressed roster.

## Verification

- [ ] Prove with spies that an enforced suppression never reaches prompt construction, `runAgent()`, or OpenCode process/SDK invocation.
- [x] Verify that mentioning one agent selects that agent while ambient seats still follow the configured energy policy.
- [x] Verify that explicit whole-room invitations select the full healthy enabled roster.
- [ ] Verify exact-target room actions bypass ordinary heuristics.
- [x] Verify one deterministic fallback responder for an otherwise unmatched ordinary message.
- [x] Verify soft-pass selection never exceeds the energy-specific ambient limit.
- [x] Verify explicit targets remain routing-selected when unavailable but are returned in the unavailable outcome rather than invoked.
- [x] Verify anti-starvation state, deterministic tie-breaking, threshold behavior, and restart persistence.
- [x] Verify shadow mode records counterfactual decisions without changing the invoked turn list.
- [ ] Verify aggregate evidence is participant-visible while raw decisions remain owner/admin-only.
- [x] Verify the 200-decision and seven-day eligibility paths, conservative distinctness treatment, non-empty denominator, sub-5% threshold, and explicit promotion requirement.
- [x] Verify mode `off` reproduces current fan-out ordering and instructions byte-for-byte.
- [x] Verify yielded and malformed turns never produce visible transcript text.

# Current state

Initial human-message fan-out now calls the deterministic gate after constructing the unchanged candidate turn list and before any per-agent prompt or OpenCode invocation. `off` returns that original array by identity. `shadow` records counterfactual decisions and still invokes the full list. `enforce` passes only selected turns into the conversation engine; suppressed agents receive no generation or provider-session identity.

The gate consumes canonical stable-ID mentions, explicit whole-room invitations, canonical continuation ownership, live health, energy, recent participation, and persisted starvation counters. It does not inspect prose for tag affinity or invent reply ownership. Explicit room actions, presence turns, developer messages, follow-ups, objections, and synthesis retain their existing explicit targeting paths.

Invoked agents now use a bounded `TURN_DISPOSITION` contract. Valid yields and malformed directives fail closed as silent transcript turns; the legacy terminal `NO_RESPONSE_NEEDED` marker remains accepted and explanatory prose ending in that marker is stripped rather than leaked. Successful dispositions are correlated with shadow decisions to produce sanitized retrospective evidence.

Room configuration now carries a dedicated `preflightMode` with `off`, `shadow`, and `enforce`. Participant-visible settings expose bounded aggregate evidence, while raw trigger/agent records require owner/admin access. Enforcement is rejected unless an existing shadow sample spans 200 evaluated would-suppress dispositions or seven days of actual recorded shadow traffic, has a non-empty denominator, and has a false-suppression rate strictly below 5%. Promotion remains an explicit authorized settings change.

The context-delta and room-settings work from upstream `main` is integrated rather than duplicated. Cursor advancement occurs only after successful delivery of a valid disposition. All room-configuration changes increment a general configuration revision, clear summary caches in JSON and SQLite storage, reject late stale summary writes, and invalidate the in-memory summarizer cache identity. Migration 0019 drops older summary-cache entries whose prior revision semantics cannot establish compatibility.

A local generation-journal sample observed on 2026-08-27 covered 3,376 completed generations from 2026-08-21 through 2026-08-27. Of those, 1,761 (52.2%) produced no visible response. Silent turns represented approximately 65.9 million of 102.6 million provider-reported tokens and $4.49 of $6.82 in provider-reported cost. Reported cost is incomplete because several subscription-backed providers report zero. This establishes meaningful waste but does not justify maximizing suppression at the expense of conversation quality.

# Decision model

The preflight function consumes immutable snapshots and returns reasoned decisions:

```ts
interface PreflightInput {
  trigger: PreflightTrigger;
  room: RoomState;
  health: AgentHealthSnapshot;
  assignments: AssignmentRoutingSnapshot;
  routing: PreflightRoutingState;
  config: PreflightConfig;
}

interface AgentRoutingDecision {
  agent: AgentId;
  outcome: "invoke" | "suppress" | "unavailable";
  reason: PreflightReason;
}

interface PreflightDecision {
  decisions: AgentRoutingDecision[];
}
```

The caller assigns decision identity and timestamps, persists the audit projection, updates routing counters, and passes only `invoke` turns to the existing conversation engine. This preserves deterministic decision logic while making state transitions explicit and testable.

Required participants and ambient participants are deliberately separate concepts. Required signals guarantee that an agent gets a chance to consider the message. Ambient selection preserves spontaneous reactions according to room energy. Neither guarantees a visible response; the invoked agent retains the agency to yield.

# Rollout evidence

Promotion from `shadow` to `enforce` requires an explicit room-level decision informed by at least:

- the percentage of shadow-suppressed agents that actually spoke;
- the percentage of those messages judged distinct rather than repetitive using deterministic transcript evidence or human review, not another mandatory model call;
- invoked-to-yield rate by routing reason and model;
- participant diversity and cross-agent follow-ups per discussion;
- time to first visible response;
- explicit human corrections or subsequent mentions of agents omitted by the shadow decision; and
- provider-reported token and cost change projected from the counterfactual decisions.

Token reduction is a success constraint, not the sole product metric. Enforcement must be reversible per room without migration or session loss.

A room becomes eligible for that explicit decision after either 200 completed shadow suppression decisions or seven days of recorded shadow traffic, whichever comes first. Eligibility is not automatic enforcement. The observed false-suppression rate over would-suppress decisions must be below 5%, and the evidence must include a non-empty evaluable suppression denominator. A shadow-suppressed agent that actually produced a visible response counts as a distinct missed contribution unless deterministic transcript evidence establishes duplication; uncertain cases count against promotion.

Every participant may inspect bounded aggregates, including sample windows, denominators, false-suppression rates, and reason-code tallies. Raw trigger-level and agent-level routing decisions remain owner/admin-only.

# Scope boundaries

This issue owns initial human-message preflight selection, routing counters, rollout modes, sanitized routing audit data, and the minimal invoked-agent disposition contract.

It consumes canonical mention, action-target, continuation, health, and energy metadata but does not redefine those systems. Tag affinity is completely excluded until the tagging feature ships a canonical metadata contract; prose inference is prohibited. It does not infer reply ownership until a separate message/reply feature provides stable parent metadata. It does not implement provider reasoning display, a new summarizer model, or changes to bounded follow-up/synthesis safety ceilings.

Suppressed agents do not advance the existing delta cursor. When later invoked, the delta spans the suppression window and the existing cold-start fallback handles a large gap. No `noReply` synchronization is performed merely because an agent was preflight-suppressed.

# Adjacent-feature invariants

The upstream context-sync implementation landed while this issue was in progress. The integrated implementation preserves these constraints:

- A failed or cancelled generation never advances `lastSeenMessageId`; only a successfully accepted and completed disposition may commit the invocation cursor.
- A transcript-summary or cold-start-summary cache includes the room-configuration revision in its identity and invalidates on every room-configuration change.
- No cursor, cache, retrospective projection, or retry path may fabricate a generation ID for a preflight-suppressed agent.
- Mode `off` continues to reproduce the pre-gate fan-out, ordering, and turn instructions byte-for-byte even after delta-cursor or summary-cache work lands.

# Next action

Review the implementation for [#92](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/92), merge with the room mode still defaulting to `off`, then explicitly place selected rooms into `shadow` for the evidence soak. Do not promote a room until the in-product aggregate is eligible and an owner/admin makes the change.

# Evidence

- Human-message fan-out: `server/index.ts`, accepted-message job path.
- Explicit action targeting: `server/index.ts`, `/api/actions` path.
- Current ranking and whole-room invitation policy: `server/conversation.ts`.
- Current energy limits and default: `shared/conversation-energy.ts`.
- Exact sentinel parsing: `shared/message-format.ts` and `server/conversation.ts`.
- Current prompt and OpenCode invocation: `server/agent-runner.ts`.
- Canonical mention metadata: `shared/mentions.ts`.
- Current room-message schema: `server/types.ts`.
- Generation journal identity requirements: `server/generation-journal.ts`.
- Local sensitive generation journal aggregate reviewed on 2026-08-27; no raw prompt or response content copied into this record.
- Canonical implementation issue: [#92](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/92).
- Rebased implementation baseline: `origin/main` at `724752c` on 2026-08-27, including the context-delta and room-settings work from issues #91 and #93.
- Implementation: `server/preflight-gate.ts`, `server/preflight-store.ts`, `shared/message-format.ts`, `server/index.ts`, `server/room-settings-api.ts`, `src/room-configuration-dialog.tsx`, and SQLite migration 0019.

# Open questions

- None. Tag affinity remains out of scope until a canonical contract ships; aggregate and raw evidence visibility are defined above; and shadow-promotion evidence thresholds are fixed above.

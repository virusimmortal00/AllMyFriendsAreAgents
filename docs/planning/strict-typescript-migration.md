---
id: strict-typescript-migration
status: proposed
issue:
owner: unclaimed
reviewers: []
depends_on: []
reported_by: maintainer
updated: 2026-09-19
---

# Outcome

All application, server, shared, native-build, test, and visual-tooling TypeScript
is checked with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
The migration improves domain models and boundary validation instead of widening
optional properties or adding unchecked assertions merely to satisfy the compiler.

# Acceptance checks

- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are enabled in
  `tsconfig.app.json` and `tsconfig.node.json`; derived configs inherit them.
- `pnpm run types:strict:inventory -- --assert-clean=all` reports no diagnostics
  and no unassigned files.
- `pnpm run check:quality` and `git diff --check` pass on the final revision.
- The completed migration adds no `as any`, `as unknown as`, non-null assertion,
  `@ts-ignore`, or `@ts-expect-error` solely to bypass a strict diagnostic.
- Each slice records its semantic decisions, changed paths, focused tests, and
  immutable commit evidence in this document when it lands.

# Current state

TypeScript `strict`, `noImplicitOverride`, and `noFallthroughCasesInSwitch` are
already enabled. The two target options are not yet enabled in committed configs.
The live inventory is derived from the compiler rather than copied into this file:

```bash
pnpm run types:strict:inventory
pnpm run types:strict:inventory -- --slice=shared-contracts
pnpm run types:strict:inventory -- --assert-clean=shared-contracts
```

Every diagnostic must map to exactly one slice. The command fails if a diagnostic
appears outside the declared ownership rules, preventing new paths from being
silently missed.

| Wave | Slice | Owned paths | Status | Depends on | Completion evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | `shared-contracts` | `shared/**` | Complete | — | `--assert-clean=shared-contracts`; focused shared tests; repository typecheck |
| 2 | `client-runtime` | Non-test `src/**` | Complete | `shared-contracts` | `--assert-clean=client-runtime`; focused client tests; repository typecheck |
| 2 | `server-runtime` | Non-test `server/**` excluding boundary paths | In progress: parsing and sequencing invariants | `shared-contracts` | Strict inventory and focused server tests |
| 2 | `server-boundaries` | Storage, GitHub, OpenRouter, OpenCode, repository, broker, and command boundaries | Not started | `shared-contracts` | — |
| 3 | `client-tests` | `src/**/*.test.ts?(x)` | Complete | `client-runtime` | `--assert-clean=client-tests`; focused suites including all 36 reconnect-flow tests; repository typecheck |
| 3 | `server-tests` | `server/**/*.test.ts?(x)` | Not started | Both server runtime slices | — |
| 3 | `visual-tooling` | `tests/visual/**` and scripts included by `tsconfig.visual.json` | Not started | Shared and client runtime | — |
| 4 | Configuration gate | Authoritative and derived TypeScript configs | Not started | All remediation slices | — |

## Update protocol

At the start and end of every slice, the implementing agent must:

1. Run the live inventory for its slice and inspect every reported file.
2. Update this table in the same commit as the code or evidence it describes.
3. Add a decision-log entry for contract or fallback choices that are not obvious
   from the final code.
4. Record exact focused checks and the commit SHA after the atomic commit exists.
5. Run the complete inventory to confirm no diagnostic became unassigned or moved
   into another slice unexpectedly.

## Decision log

| Date | Slice | Decision and rationale | Paths/evidence |
| --- | --- | --- | --- |
| 2026-09-19 | Planning | Remediate under command-line flags before enabling both options in the two authoritative base configs. This keeps every intermediate commit buildable while derived configs inherit the final policy. | `tsconfig.app.json`, `tsconfig.node.json`, `tsconfig.visual.json`, `tsconfig.native.json` |
| 2026-09-19 | Planning | Treat absent properties, present `undefined`, missing lookups, and invalid state as separate domain cases. Compiler silence alone is not acceptance evidence. | Inventory error families TS2375/TS2379/TS2412 and TS2532/TS18048/TS2345 |
| 2026-09-19 | Planning | Use a compiler-derived inventory and fail on unassigned diagnostics instead of maintaining a copied file checklist that can drift. | `scripts/strict-type-inventory.ts` |
| 2026-09-19 | `shared-contracts` | Preserve complete registries as exact object shapes, and validate regex captures and URL segments at runtime where input is external. This represents the actual boundary invariant instead of asserting indexed values exist. | `shared/chat-style.ts`, `shared/command-domain.ts`, `shared/human-avatar.ts`, `shared/message-format.ts`, `shared/model-presentation.ts`, `shared/openrouter-model-page.ts`, `shared/workshop.ts` |
| 2026-09-19 | `shared-contracts` | Omit unknown roster profiles from mention suggestions, retain explicit ambiguity handling during offset reconciliation, and omit unavailable provider/model snapshots rather than serializing present `undefined` values. | `shared/mentions.ts`, `shared/mentions.test.ts` |
| 2026-09-19 | `shared-contracts` | Preserve absence for unavailable diagnostics and legacy model-selection fields. A missing diagnostic is distinct from a present empty value, while legacy reasoning effort is migrated only when it is actually present. | `shared/model-discovery.ts`, `shared/roster.ts`, `server/model-discovery.test.ts`, `shared/roster.test.ts` |
| 2026-09-19 | `client-runtime` | Centralize optional abort-signal construction for read requests so an absent signal remains absent from `RequestInit`; continue routing malformed API roots through room scope instead of treating an unchecked segment as global. | `src/api.ts` |
| 2026-09-19 | `client-runtime` | Model explorer page collections as non-empty because rendering requires a selected fallback; keep an explicit guard for filtered keyboard-navigation results because every page may be disabled. | `src/administration-window.tsx`, `src/explorer-layout.tsx` |
| 2026-09-19 | `client-runtime` | Build sortable participant display records with optional maker/provider fields only when known. This preserves the concrete record subtype through generic sorting and prevents an absent display attribute from erasing unrelated fields during inference. | `src/components.tsx`, `src/roster-manager.tsx`, `src/agent-list-sort.ts` |
| 2026-09-19 | `client-runtime` | Centralize provider-mark prop construction so unknown maker and access-provider identities are omitted consistently across roster and model views. The component contract remains exact rather than accepting present `undefined`. | `src/provider-mark.tsx`, `src/provider-mark.test.ts`, `src/components.tsx`, `src/model-picker.tsx`, `src/roster-manager.tsx` |
| 2026-09-19 | `client-runtime` | Move roster draft transitions into pure helpers. Model replacement removes stale variant and confirmation state, selecting the default removes both modern and legacy variant fields, and confirmation removes its diagnostic fields rather than persisting empty sentinels. | `src/roster-entry-edit.ts`, `src/roster-entry-edit.test.ts`, `src/roster-manager.tsx`, `src/roster-manager.test.tsx` |
| 2026-09-19 | `client-runtime` | Treat removal of a human avatar as property absence in profile mutations and presentation props. The initials fallback is selected by an omitted image rather than a present `undefined` value. | `src/human-avatar.tsx`, `src/human-avatar.test.tsx`, `src/components.tsx` |
| 2026-09-19 | `client-runtime` | Keep optional refresh counters and agent-label maps absent across integration and usage composition boundaries. Child defaults now distinguish omission from an explicitly supplied value without widening their contracts. | `src/integrations.tsx`, `src/openrouter-integration-section.tsx`, `src/room-usage-dialog.tsx` |
| 2026-09-19 | `client-runtime` | Make the spend-chart's parallel-array invariant executable. Percentage allocation and palette lookup now fail explicitly if internal arrays diverge instead of allowing unchecked values into SVG and legend output. | `src/spend-chart.tsx`, `src/spend-chart.test.tsx` |
| 2026-09-19 | `client-runtime` | Narrow menu commands with a reusable type guard and stop keyboard handling when a menu or selected item is absent. Separators and disabled commands remain non-invokable without relying on unchecked indices. | `src/classic-menu.tsx`, `src/classic-menu.test.tsx` |
| 2026-09-19 | `client-runtime` | Validate markdown parser captures before rendering links and omit the transcript improvement callback when unavailable. Invalid internal parser state now fails closed as plain text rather than flowing unchecked values into React. | `src/components.tsx`, `src/components.test.tsx` |
| 2026-09-19 | `client-runtime` | Make composer mention boundaries explicit: inspect the preceding character without unchecked indexing, omit unavailable provider/model snapshots, and ignore selection keys when the active suggestion no longer exists. | `src/components.tsx`, `src/mentions.test.tsx` |
| 2026-09-19 | `client-runtime` | Validate non-empty diagnostic chunk groups and captured improvement route IDs before indexing them. Re-check a selected trace ID inside its event callback because the selected record can change before invocation. | `src/diagnostics.tsx`, `src/improvements.tsx` |
| 2026-09-19 | `client-runtime` | Preserve connection-health fields across snapshots only when a prior or incoming value exists. Initial room enrichment likewise applies only values returned by the request, so omission remains distinct from a present `undefined` property. | `src/room-reconciliation.ts`, `src/room-reconciliation.test.ts`, `src/App.tsx` |
| 2026-09-19 | `client-runtime` | Keep transcript magnification within the normalized level when an internal index is unexpectedly unavailable, require the sole typing participant before naming it, and derive menu access keys with non-throwing string access. | `src/transcript-view.ts`, `src/transcript-view.test.ts`, `src/App.tsx` |
| 2026-09-19 | `client-runtime` | Compose optional room and dialog props only from available state. This keeps child contracts exact and prevents React boundaries from converting missing availability, health, repository, protected-work, provider, capability, and selection state into present `undefined` values. | `src/App.tsx`, `src/reconnect-flow.test.tsx` |
| 2026-09-19 | `client-tests` | Build test fixtures with genuinely absent avatar, generation, and client-message fields. These cases now exercise the production omission contract instead of representing absence as explicit `undefined`. | `src/api-identity.test.ts`, `src/diagnostics.test.tsx`, `src/room-reconciliation.test.ts` |
| 2026-09-19 | `client-tests` | Guard captured callbacks, requests, and retry attempts after asserting their expected counts. Static ordered display data is modeled as a tuple; asynchronous mock evidence now fails with an explicit test invariant instead of relying on unchecked indexing. | `src/agent-list-sort.test.ts`, `src/api-identity.test.ts`, `src/classic-menu.test.tsx`, `src/composer.test.tsx`, `src/github-integration-panel.test.tsx`, `src/protected-work.test.tsx` |
| 2026-09-19 | `client-tests` | Validate loaded investigation fixtures and parsed responsive-audit table/capture fields before use. Malformed planning rows remain excluded, while missing test fixtures fail explicitly instead of producing partial typed records. | `src/investigations.test.tsx`, `src/responsive-view-audit.test.ts` |
| 2026-09-19 | `client-tests` | Inspect recorded network calls only after establishing that the expected request and body exist. Parsed roster payloads also require an entry before field assertions, so failed setup produces a targeted invariant error rather than an unchecked-access exception. | `src/room-configuration-dialog.test.tsx`, `src/roster-api.test.ts`, `src/roster-manager.test.tsx` |
| 2026-09-19 | `client-tests` | Centralize positional test-fixture access in a fail-fast helper for reconnect event sources, message calls, and roster agents. The harness still tests exact event ordering, but missing setup evidence now reports which indexed fixture was absent. | `src/reconnect-flow.test.tsx` |
| 2026-09-19 | `server-runtime` | Validate positional timing inputs and regular-expression captures before use. Burst delivery fails explicitly on an internal sparse-array invariant, while mention detection safely ignores room participants without a registered presentation profile. | `server/response-pacing.ts`, `server/burst-delivery.ts`, `server/agent-health.ts`, `server/structured-room-turn.ts`, `server/structured-room-turn.test.ts` |
| 2026-09-19 | `server-runtime` | Give log-context scopes an explicit list of inherited optional identities to clear. New conversation runs and turns now remove stale turn, generation, and attempt keys instead of retaining those keys with `undefined` values. | `server/structured-logger.ts`, `server/conversation-context.ts`, `server/conversation-context.test.ts` |
| 2026-09-19 | `server-runtime` | Construct query and pagination records only from values supplied by the caller. An explicitly parsed empty task-state filter remains present, while absent cursors and continuation limits remain absent instead of becoming present `undefined` properties. | `server/continuation-api.ts`, `server/task-api.ts`, `server/room-lifecycle-api.ts` |
| 2026-09-19 | `server-runtime` | Model the event-stream heartbeat handle as an always-declared lifecycle slot whose value can be unset. Disconnect clears that slot, and a later connection is verified to start a new heartbeat rather than inheriting stale timer state. | `server/room-event-stream.ts`, `server/room-event-stream.test.ts` |
| 2026-09-19 | `server-runtime` | Build command capability status as an exhaustive object checked against the canonical command-name union. Known commands are now total lookups, and adding a future command requires an explicit policy entry at compile time instead of weakening lookups with optional chaining. | `server/capability-policy.ts`, `server/capability-policy.test.ts` |
| 2026-09-19 | `server-runtime` | Preserve omission through consultation request normalization, MCP adaptation, recovery pagination, and provenance sanitization. Supplied empty participant lists remain explicit selections, while unavailable context, cursors, and source identifiers are not materialized as present `undefined` fields. | `server/consultation-mcp.ts`, `server/consultation-service.ts` |
| 2026-09-19 | `server-runtime` | Model the built-in context summarizer chain as an exact readonly primary/fallback pair. Room defaults and fallback derivation can now rely on both positions, while any future change to the chain's cardinality requires an explicit policy update. | `server/agent-context-config.ts`, `server/room-configuration.ts`, `server/room-configuration.test.ts` |
| 2026-09-19 | `server-runtime` | Separate the optional loaded-state lifecycle from the required single-owner invariant. Owner transfer and recovery now resolve the validated owner through one fail-fast helper, and transfer coverage verifies role persistence plus immediate revocation of both principals' sessions. | `server/control-plane.ts`, `server/control-plane.test.ts` |
| 2026-09-19 | `server-runtime` | Capture protected-return record and revision snapshots before entering exclusive asynchronous sections so revalidation compares against the intended state, not a mutable outer binding. Archive trimming now fails explicitly if its dense-entry invariant is violated rather than corrupting byte accounting. | `server/protected-work-service.ts`, `server/protected-work-store.ts` |
| 2026-09-19 | `server-runtime` | Normalize JSON room state by omitting cleared transient status, absent session fingerprints, and absent fork titles. Treat participant-style completeness and encoded context-summary keys as checked store invariants; restart coverage verifies cleared status fields remain absent on disk. | `server/room-store.ts`, `server/room-store.test.ts` |
| 2026-09-19 | `server-runtime` | Centralize agent-scoped transcript result construction so unavailable cursors remain absent in every summary and fallback path. Capture non-empty summary spans and narrowed provider/cache dependencies once; skip sparse source slots while failing explicitly on impossible sparse internal transcript entries. | `server/transcript.ts`, `server/transcript.test.ts` |

# Next action

Begin `server-runtime` with a full file-level inventory review, then select the
smallest coherent domain group. Keep boundary-owned files in `server-boundaries`
so independent storage and external-service contracts remain reviewable.

# Evidence

- `pnpm run types:strict:inventory` is the reproducible current-state inventory.
- `scripts/strict-type-inventory.test.ts` locks the ownership rules and summary
  behavior.
- `tsconfig.strict-inventory.json` keeps the inventory implementation itself
  inside the normal strict type-check gate.
- Initial read-only compiler measurements found that unchecked indexed access is
  the larger error family, while exact optional properties have broader boundary
  semantics and therefore require case-by-case decisions.

# Open questions

- Which public GitHub issue should become canonical before this record moves from
  `proposed` to `active`? Creating or changing that public artifact requires
  separate maintainer authorization.

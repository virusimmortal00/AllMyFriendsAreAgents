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
| 1 | `shared-contracts` | `shared/**` | Not started | — | — |
| 2 | `client-runtime` | Non-test `src/**` | Not started | `shared-contracts` | — |
| 2 | `server-runtime` | Non-test `server/**` excluding boundary paths | Not started | `shared-contracts` | — |
| 2 | `server-boundaries` | Storage, GitHub, OpenRouter, OpenCode, repository, broker, and command boundaries | Not started | `shared-contracts` | — |
| 3 | `client-tests` | `src/**/*.test.ts?(x)` | Not started | `client-runtime` | — |
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

# Next action

Run and review the `shared-contracts` inventory, then implement only the shared
contract and helper changes needed to clear that slice. Add characterization tests
before any change whose absent-versus-undefined behavior is not already explicit.

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

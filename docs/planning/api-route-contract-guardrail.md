---
id: api-route-contract-guardrail
status: proposed
issue:
owner: unclaimed
reviewers: []
depends_on: []
reported_by: maintainer
updated: 2026-09-18
---

# Outcome

The client↔server API seam is a fail-closed contract: every Express route
registered under `server/`, every browser call in `src/api.ts`, and the
room-scoping classification of every API root are checked against a single
shared table (`shared/api-routes.ts`) on every pull request, so the three
cannot drift apart silently. This is the first enforcement piece of the
agreed per-slice operating loop: contract-first, landed as one vertical.

# Acceptance checks

- `pnpm run check:api-contracts` exits 0 on the current tree and fails with
  a file:line message when: a server route is registered but not in the
  table; a table row matches no registration; a browser `request(...)` call
  matches no registered route or the wrong method; a `room`-scoped root
  lacks its `/api/rooms/:roomId` twin; a `canonical` root lacks its
  migration note; or a browser component outside `src/api.ts` embeds a raw
  `/api/...` path.
- `scripts/check-api-route-contracts.test.ts` pins the matching rules and
  each failure mode.
- The step runs in the required Quality gates workflow and in
  `pnpm run check:quality`.
- `src/api.ts` derives its room-scoping root set from `shared/api-routes.ts`
  instead of a hand-maintained local literal set.
- Registrations with interpolated (non-literal) route paths are rejected, so
  new routes cannot escape the contract by construction.

# Current state

Implemented and passing on the current tree: 156 registered routes across
`server/` (excluding vendored `node_modules` and tests), 72 client call
sites, all roots classified. The scanner is a TypeScript AST pass over
`server/**/*.ts` and `src/api.ts`; it resolves `roomPath(...)` wrappers and
literal-union parameters so every call is checked statically without booting
the server.

The check also prints known gaps it must not yet fail on: 14 roots
(`tasks`, `continuations`, `investigations`, `room`, `roster`, and others)
are classified `canonical` because the browser rewrites them under
`/rooms/:roomId` views while the server only serves the canonical room —
the multi-room migration (#60) completes those twins and flips the root to
`room`, after which missing twins become failures. Gap lines are aggregated
per root and point at #60 as the completing work.

# Next action

Open a work-item issue from this record and move `status` to `active` when
the route contract is first asked to gate a feature slice; or land it as-is
so every subsequent PR runs it.

# Evidence

- `shared/api-routes.ts` — the contract table (roots with scope + notes,
  156 route rows).
- `scripts/check-api-route-contracts.ts` — scanner, matcher, and checker;
  `--emit-routes` prints the observed server inventory.
- `scripts/check-api-route-contracts.test.ts` — 14 tests over matching,
  extraction, boundary, and failure modes.
- Local run: `api route contracts verified: 156 server routes, 72 client
  call sites, 14 known tracked gap(s).`
- `.github/workflows/quality-gates.yml` — new "Enforce client-server API
  route contracts" step; `package.json` — `check:api-contracts` wired into
  `check:quality`.

# Open questions

- Should `canonical` roots fail (not just report) once the #60 waves land
  per-room twins? The current design defers that flip to the migration
  slice that completes each twin.
- Response/request body schemas are not yet part of the table; adding a
  shared zod schema per route row is the natural next contract layer.

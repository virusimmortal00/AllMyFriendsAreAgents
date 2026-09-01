# Repository guidance for agents

## Start here

1. Read the issue or task, then the smallest relevant public design or planning
   document. Do not load all of `docs/planning/` by default.
   For visible interface work, read `docs/design/ui-standards.md` and locate the
   affected stable view IDs in `docs/design/responsive-view-audit.md` before
   editing. Register a genuinely new view in `src/view-registry.ts`, attach it
   to its rendered root, and add its audit row as `Pending` before implementation.
2. Check `git status` before editing. Preserve existing and unrelated changes.
3. Use Node.js 24 or newer and pnpm. CI uses pnpm 10 and `pnpm-lock.yaml` is the
   authoritative dependency lock. Do not run `npm install` or regenerate the
   legacy `package-lock.json` unless the task explicitly addresses npm support.
4. Install dependencies with `pnpm install --frozen-lockfile`.
5. Run the smallest relevant test while iterating, then the proportional
   validation set before handing work back.

The normal local development command is `pnpm dev`; the web interface defaults
to `http://127.0.0.1:4173` and the API to `http://127.0.0.1:53147`. Most tests do
not require a configured model provider. Follow the README for live provider
setup and `.env.example` for configuration names.

## Codebase map

| Path | Responsibility |
| --- | --- |
| `src/` | React interface, browser state, reconciliation, and client API calls |
| `server/` | Express APIs, orchestration, authorization, persistence, logging, and external-service boundaries |
| `server/storage/` | Storage contracts, JSON and SQLite repositories, and migrations |
| `shared/` | Types, validation, protocol contracts, and domain logic shared across browser and server |
| `scripts/` | Operational CLIs, canaries, and repository guardrails |
| `plugins/all-my-friends-are-agents/` | Portable MCP plugin plus thin client adapters and its canonical consultation skill |
| `docs/operations/` | Operator-facing capability, logging, retention, and erasure procedures |
| `docs/planning/` | Public decision records and historical planning context; GitHub Issues remain the active tracker |

Keep cross-boundary contracts in `shared/` instead of duplicating types in the
browser and server. The plugin's canonical behavior belongs in its portable
core; host-specific adapters should remain thin. Server and shared TypeScript
use NodeNext-style `.js` relative import specifiers, while `src/` follows the
existing Vite/bundler import style.

## Core invariants

- Local-first and loopback-only are safe defaults. Do not weaken bind guards,
  allowed-host checks, authentication, CSRF protection, or credential handling
  to make a development scenario easier.
- The server is authoritative for identity, permissions, capabilities, room
  state, generation state, and mutation results. Client visibility is never an
  authorization boundary.
- Room participants converse and inspect read-only context. Source mutations
  happen only through governed assignment and contribution boundaries; do not
  add a direct room-to-worktree write path.
- Persistent and external mutations should be scoped, validated, idempotent
  where retries are possible, auditable, and fail closed when authority or
  state cannot be established.
- Keep credentials server-side. Redact secrets, prompts, personal data, private
  URLs, and unnecessary machine details from APIs, logs, diagnostics, fixtures,
  screenshots, and test failures.
- Changes to storage schemas or durable records require migration, restart, and
  round-trip coverage. Preserve existing data unless destructive migration is
  explicitly authorized.
- MCP and remote-client work must retain explicit room IDs, continuation
  cursors, mutation idempotency keys, and negotiated compatibility behavior.

## Working method

- Search for the existing type, service, route, component, and nearest tests
  before introducing a new abstraction. Extend canonical code paths rather than
  creating a parallel implementation.
- Files mapped by `integration-contracts/opencode.json` consume behavior from
  OpenCode's public source. Before editing one, run
  `pnpm check:integration-contracts -- --inspect-files <repository-relative-path>`,
  inspect every reported upstream path at an exact commit, update the review
  record, and run the reported contract tests.
  Follow `docs/integrations/opencode.md`; documentation or memory alone is not
  compatibility evidence.
- Keep changes bounded to the requested outcome. Avoid speculative refactors,
  compatibility shims, new dependencies, or broad formatting passes unless they
  are required by the task.
- Place tests beside the code as `*.test.ts` or `*.test.tsx`. Browser interaction
  tests that need a DOM declare `// @vitest-environment jsdom` and use Testing
  Library patterns already present in `src/`.
- Use temporary directories and ephemeral ports in server tests. Clean them up
  and avoid touching `.allmyfriendsareagents/`, `.runtime/`, real credentials,
  or a developer's live room state.
- Treat `pnpm canary:investigations` as the provider-free canary. Do not run
  `pnpm canary:investigations:real`, publish, deploy, or invoke paid or live
  external services without explicit authorization.
- Follow the style of the surrounding file. This repository has no standalone
  lint or format script, so do not invent one as a required check.

## Validation

Use the smallest set that proves the change, then broaden according to risk:

```bash
# One focused file while iterating
pnpm exec vitest run path/to/file.test.ts

# Full repository quality gate
pnpm run check:quality

# Planning/template changes
pnpm check:planning-docs -- --self-check

# All changes
git diff --check
```

For visible interface changes, also run the app and verify the affected flow in
a browser at Phone, Tablet, Short laptop, and Desktop checkpoints defined in
`docs/design/responsive-view-audit.md`, unless the change provably cannot affect
layout or interaction at a checkpoint. Record the affected IDs and evidence in
the audit and pull request. View identities must come from `src/view-registry.ts`
through a shared surface or `viewAttributes`; do not duplicate raw ID/name/state
strings in product components. For authorization, storage,
protocol, or retry behavior, test denial and recovery paths as well as success.
If a required check cannot run, report the exact reason and what remains
unverified; do not describe an unrun check as passing.

For UI work, follow `docs/testing/visual-review.md`: capture rendered screenshots,
run `pnpm review:visual --run <capture-directory>` locally through a fresh Codex
review session, retain its per-image seven-question verdicts and receipts, and
run `pnpm check:visual-review` against the exact
capture. Neither CSS-string tests nor a successful screenshot job constitute
visual approval. Explicitly list views and real-device behavior still unverified.
The account-backed reviewer consumes Codex usage and requires explicit permission
to run; never put ChatGPT credentials in public CI or fall back to an API key.

## Public repository boundary

Treat every committed file, GitHub issue, pull request, review, comment, commit
message, screenshot, and attached log as public. Write for a contributor who has
no access to private room transcripts, meetings, local machines, provider
sessions, or internal business discussions.

Before publishing or committing project context:

- Make the artifact understandable without the conversation that produced it.
- Introduce every project-specific term and link to public context where useful.
- Replace internal shorthand, jokes, sales language, and meeting narration with
  a neutral description of the user need, technical constraint, or product
  decision.
- Separate verified facts from reports and hypotheses. If a private report has
  not been reproduced, say so; do not turn it into a confirmed claim.
- Preserve only the provenance needed to understand or reproduce the work.

Private chat, room, and meeting decisions are transient inputs, not durable
project records. Restate the resulting decision, rationale, and actionable
context in the relevant issue, pull request, or committed document. Do not rely
on a private transcript or a link to one as the explanation.

## Publication authorization

Agents may prepare drafts, but creating or changing a GitHub issue, pull
request, review, comment, release, or other public artifact requires explicit
authorization for that publication action. Repository access or permission to
edit local files is not publication approval. Use the project's governed,
scoped contribution path when it is available.

The human authorizing publication remains responsible for the result. Do not
add model-generated boilerplate, "generated by" signatures, or agent co-author
footers unless a maintainer explicitly requests them.

## Translating private development context

Private agent conversations and local experiments may inform public work, but
their raw wording is usually not public evidence.

- Do not quote or name a private room participant, model, provider session, or
  developer unless that identity is relevant, intentionally public, and
  explained in the artifact.
- Paraphrase useful private feedback as a standalone observation, requirement,
  or open question. Verify it when possible and attach reproducible evidence.
- Replace local paths, hostnames, usernames, branch or worktree trivia, session
  IDs, and tool-specific state with portable descriptions. Include sanitized
  environment details only when they are required to reproduce a defect.
- Do not publish raw transcripts, prompts, model output, meeting notes, customer
  information, private URLs, credentials, tokens, or non-public incident data.
- Never imply that agent-generated text is authoritative. Treat it as a
  hypothesis until supported by code, tests, documentation, or a reproducible
  observation.
- Treat environment-variable values, cookies, authorization headers, and
  configuration exports as sensitive unless they are known example values.
  Preserve variable names when useful, but replace values with obvious
  placeholders.

Attributed quotes are acceptable when they are intentionally part of the public
project story, as in a documented demo, and the source and context are clear to
an unfamiliar reader. Otherwise, paraphrase the underlying point and omit the
private attribution.

Keep raw development context in Git-ignored local state or an approved private
workspace. A file being convenient for development is not a reason to commit
it. Git-ignored data can still be sensitive and must not contain credentials
unless the owning tool is specifically designed to store them securely.

## Evidence and links

- Prefer stable public URLs, repository-relative paths, commit identifiers, and
  reproducible commands. Do not cite private dashboards, local files, expiring
  links, or transient logs as the only evidence for public work.
- Use fictional placeholder people, organizations, domains, repositories, and
  credentials in examples unless a real public identity is necessary.
- Include the smallest useful log or trace excerpt. Remove tokens, cookies,
  prompts, personal data, private URLs, and unrelated machine information.
- For defects, capture expected and actual behavior, minimal reproduction steps,
  relevant versions, and only the environment details that affect the result.
- Route suspected vulnerabilities through `SECURITY.md`. Never publish exploit
  details, sensitive proof-of-concept material, or unpatched vulnerability
  information in an issue or pull request.

## Public issue and planning style

Use the repository work-item structure for bugs, features, and planning records:

1. **Outcome**: describe the observable result or user value.
2. **Acceptance checks**: list concrete, verifiable completion checks.
3. **Current state**: distinguish what is implemented, observed, reported, and
   unknown.
4. **Next action**: name the next bounded step without private ownership or
   meeting narration unless ownership is intentionally public.
5. **Evidence**: include public links, code locations, tests, traces, sanitized
   reproduction details, or commit identifiers.
6. **Open questions**: retain only decisions that could materially change scope
   or implementation.

Before publishing an issue, confirm that:

- its title describes the work without internal priority codes or shorthand;
- the body contains no unexplained people, agents, codenames, rooms, or meetings;
- commercial considerations use objective product language rather than private
  speculation;
- environment-specific details are portable, relevant, and sanitized; and
- an outside contributor can understand why the work matters and how completion
  will be verified.

## Pull requests and commits

- Pull request descriptions should explain what changed, why it changed, and
  how it was verified without reconstructing the work from chat.
- Commit messages should be concise and descriptive. Omit private provenance and
  tool or model attribution that does not help maintain the project.
- Record test commands and meaningful manual verification. A green test suite
  does not replace reproduction or manual checks when behavior depends on a
  browser, operating system, provider, or external integration.

## Documentation ownership

- `README.md` is for users and the public product story.
- `CONTRIBUTING.md` is the human-facing contribution and public-artifact guide.
- `AGENTS.md` is the operational instruction source for coding agents and
  maintainers supervising them.
- `SECURITY.md` is the vulnerability-reporting policy.
- `docs/planning/` contains durable public decisions and historical context, not
  raw development transcripts.

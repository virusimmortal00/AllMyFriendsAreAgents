# OpenCode upstream integration contract

OpenCode is the application's execution runtime. Its source code is therefore
part of this repository's effective integration specification, even though it
lives in a separate public repository.

The machine-readable contract is
[`integration-contracts/opencode.json`](../../integration-contracts/opencode.json).
It maps local integration surfaces to the exact upstream files that define the
behavior being consumed. `pnpm check:integration-contracts` evaluates the Git
diff, reports affected surfaces, verifies the review record, and runs their
focused tests.

## Required workflow

Before changing a mapped local file:

1. Run
   `pnpm check:integration-contracts -- --inspect-files <repository-relative-path>`
   before editing to identify the affected surfaces. Multiple paths may be
   comma-separated. After editing, the plain command derives them from the diff.
2. Inspect every reported upstream path at an exact OpenCode tag and commit.
   Compare it with the commit already recorded in the contract. When a
   downstream build is admitted, also inspect its complete diff from the
   recorded base through the recorded head.
3. Update the contract review revision, tag, commit, paths, and standalone
   result. The result must distinguish confirmed behavior from inference.
4. Update provenance-tagged fixtures and contract tests when an upstream shape
   or behavior changed.
5. Run the focused tests reported by the checker and the proportional repository
   quality gate.

Pull requests that touch a mapped surface must also complete the OpenCode
upstream-review section in the pull request template. CI checks that its commit
and affected surface IDs match the committed contract review.

No guard can prove that a contributor understood source code. This guard instead
requires reproducible evidence tied to an immutable commit and executable tests.

## Version policy

`minimumVersion` is the oldest supported upstream runtime. `auditedVersion` is
the newest upstream version whose relevant source and provider-free binary
interface have been checked. Exact stable versions in that closed range are
admitted. The contract may additionally record one exact downstream runtime
identity, immutable base and head commits, ordered patch commits, and reviewed
paths. Other prerelease and build variants fail discovery rather than inheriting
capabilities from a major-version guess. The version identity selects reviewed
source provenance; it is not a cryptographic binary attestation. This strict
policy is temporary: issue
[#70](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/70)
tracks replacement of console parsing and inferred capabilities with the
structured server/SDK transport and negotiated behavior.

The weekly upstream-watch workflow compares the latest OpenCode release with the
audited tag and verifies the recorded upstream paths. It reports drift without
automatically changing public issues, pull requests, or the supported range.

The currently approved downstream identity is `1.18.25-amfaa.2`, based on
upstream v1.18.25 at `cb7d8b2f5e44876ef98b661dc10590c915af3a9f` and ending at
`6883ca5bd35a5494fb2759018373308911c79e01`. Stock OpenCode remains the default;
an operator must explicitly select a downstream binary. The source-verification
check confirms that the public branch still resolves to the recorded head and
that every recorded path exists at the exact upstream and downstream commits.

## Current audit

The v1.18.25 review compared the mapped source with v1.18.18, the previous audit
baseline. The CLI JSON event projection, model console format, inline permission
merge, and custom-tool definition remained compatible. The run loop added child
session tracking for permission replies. Because room execution supplies a
deny-by-default inline permission map and does not use `--auto`, that change does
not broaden the room lane's authority.

The repository pins `@opencode-ai/plugin` to the audited version and type-checks
`server/agent-tools/` as part of the normal build. This ensures that custom tools
cannot silently drift outside the quality gate.

## CLI text-part assembly

The 2026-08-30 review re-inspected v1.18.25 at the recorded commit. The CLI run
loop emits `text` only from a completed `message.part.updated` text part with an
end time. The session processor accumulates provider deltas before publishing
that snapshot; `message.part.delta` is not projected into CLI `text` events.
Each part carries `sessionID`, `messageID`, and `id`. The minimum supported
v1.18.18 revision (`31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d`) has the same
completed-text CLI projection.

Consequently, separate CLI text events must not be treated as token fragments.
The room runner preserves complete part contents and first-seen part order,
replacing repeated snapshots by the compound session/message/part identity.
Distinct parts, including parts within one assistant message, are separated by
blank lines. Equal text under different identities is not deduplicated. Empty
replacement snapshots remove earlier text without creating empty paragraphs.
Reasoning, tool output, and delta events never become room chat.

Compatibility behavior is explicit:

- Without complete string identities, each text event remains a separate part;
  it is neither guessed to be a delta nor deduplicated by content.
- Missing timing remains accepted for compatibility. An explicitly supplied
  timing record without a finite positive end time is not a completed part.
- Non-string text and non-protocol progress are ignored. Existing provider
  failure, cancellation, and empty-response handling remain unchanged.
- The external runner result remains a string. Both pre-tool and post-tool
  visible text remain eligible for delivery under existing filters and limits;
  this fix does not select only the terminal assistant message.
- Missing `TURN_DISPOSITION` retains legacy text compatibility. Malformed or
  duplicate directives suppress the turn; valid yield directives stay silent.
  Restored paragraph boundaries let the existing leading-preface filter work.
  Exact current-speaker prefixes are removed only at the start of an outgoing
  message, not by deleting arbitrary brackets or searching inside prose/code.
  None of these cases introduces a model retry.

`server/fixtures/opencode-completed-text-parts.json` is fictional, provider-free
source-contract evidence, not a recorded provider conversation. Its provenance
is checked against the contract by `server/agent-runner.test.ts`.

The upstream session API supports a `json_schema` output format through a
required `StructuredOutput` tool, but the audited `run --format json` path does
not request that format: its `json` flag controls event serialization only.
The room therefore retains this parser for stock-runtime and writable turns;
schema-constrained output uses the separate SDK/server lane described below.

Source anchors at the audited commit:

- [CLI completed-part projection and prompt request](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/run.ts#L678-L876)
- [Provider delta accumulation and text completion](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/processor.ts#L486-L531)
- [Text-part identity and output formats](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/schema/src/v1/session.ts#L65-L116)
- [Assistant-message creation and structured output](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/prompt.ts#L1186-L1318)

## Structured read-only room turns

Read-only turns use OpenCode's v2 SDK only when discovery reports the exact
approved downstream runtime identity. The application starts an authenticated
loopback server for the turn, verifies the server-reported version, creates or
resumes a session, and requests the versioned room-turn JSON Schema. The result
is read from `AssistantMessage.structured` and validated again by the
application before delivery. The provider-facing schema uses a flat object
envelope for broad tool-schema compatibility; the application enforces its
action-specific union and allows at most one same-session semantic correction.
Invalid, missing, or extra-field results then fail closed; they are never
recovered by scraping assistant prose. Cancellation and timeouts abort the
session and terminate the owned server process.

The downstream prompt loop leaves ordinary read-only tools available on the
initial structured step. If the model finishes with plain text instead of the
structured call, or submits an invalid structured value, the single bounded
recovery step exposes only `StructuredOutput` and requires that tool. This
preserves normal agent flow before finalization while making the correction
step deterministic; application validation remains the final authority.

This is deliberately a narrow capability boundary. Stock OpenCode versions and
all writable turns continue through the existing CLI transport. Per-turn server
startup preserves the current lease and environment isolation; server reuse is
a later performance optimization that must preserve those boundaries. The SDK
package is pinned to the audited upstream version and the structured lane still
requires the separately versioned downstream runtime because upstream v1.18.25
does not provide the same validated, bounded schema-retry behavior.

Source anchors at the audited commit:

- [Authenticated server configuration](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/server/auth.ts)
- [Server health and lifecycle](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/server/server.ts)
- [Generated v2 session and health methods](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/sdk/js/src/v2/gen/sdk.gen.ts)
- [Generated structured message and output-format types](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/sdk/js/src/v2/gen/types.gen.ts)

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
   Compare it with the commit already recorded in the contract.
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

`minimumVersion` is the oldest supported runtime. `auditedVersion` is the newest
version whose relevant source and provider-free binary interface have been
checked. Versions outside that closed range fail discovery rather than inheriting
capabilities from a major-version guess. This strict range is temporary: issue
[#70](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/70)
tracks replacement of console parsing and inferred capabilities with the
structured server/SDK transport and negotiated behavior.

The weekly upstream-watch workflow compares the latest OpenCode release with the
audited tag and verifies the recorded upstream paths. It reports drift without
automatically changing public issues, pull requests, or the supported range.

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

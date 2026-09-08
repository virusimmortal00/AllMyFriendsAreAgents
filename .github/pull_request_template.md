<!--
This is a public repository. Write for reviewers who cannot see private rooms,
meetings, local environments, or internal planning. Paraphrase private input,
preserve uncertainty, and remove secrets, personal data, private URLs, raw logs,
and unexplained agent or developer attribution. Follow CONTRIBUTING.md and use
SECURITY.md for vulnerability reports.
-->

## Change

Describe the user-visible outcome and the failure mode this change addresses.

## Evidence

- [ ] `pnpm run check:quality` passes locally.
- [ ] New or changed behavior has a regression test that fails without the implementation.
- [ ] Existing user changes and unrelated behavior remain intact.

## UI contract review

Complete the following only for changes that affect rendered UI or interaction.
For backend, documentation, unit tests, or review-tooling changes without UI
impact, mark this section **N/A — no UI impact**. Full-app visual review is not
required for every PR.

Visual scope: <!-- Affected stable IDs and comparison base, or N/A with reason. -->

- [ ] No UI impact, or the applicable rules in `docs/design/ui-standards.md` were checked.
- [ ] Affected stable view IDs are listed in the change description; genuinely new views were added to `src/view-registry.ts`, attached to production markup, and registered in the audit as `Pending` before implementation.
- [ ] Phone, Tablet, Short laptop, and Desktop were checked for every affected view, or the description explains why a checkpoint cannot be affected.
- [ ] The affected audit rows answer screen use, navigation, retro style, proportion, empty area, scroll/actions, and outcome with explicit P/T/L/D coverage.
- [ ] Cross-cutting behavior uses a shared primitive; feature-local CSS is limited to content-specific composition.
- [ ] `View` contains presentation controls only; full-workspace destinations use `Window`.
- [ ] Every workspace replacement, overlay, and nested detail has an obvious visible exit and keyboard-safe behavior.
- [ ] Controls have accessible names, correct roles, focus behavior, and responsive coverage.
- [ ] Sanitized screenshot artifacts identify the source digest, browser, actual viewport, and stable view ID; capture/layout success is distinguished from visual approval.
- [ ] The capture scope matches the affected views (`pnpm capture:visual --base <PR-base> --plan-only`); local `pnpm review:visual` supplied each original screenshot in that scope to fresh Codex review sessions; seven-question verdicts and invocation receipts were retained, and `pnpm check:visual-review` passed for the exact scoped capture. Uncovered states and real-device gaps are explicitly listed.

If a contract must change, update the standard, its executable guard, and its regression test in this pull request. Do not bypass the guard with a type assertion or by weakening/removing a test.

## OpenCode upstream review

Complete this section when `pnpm check:integration-contracts` reports an
affected surface. It may remain not applicable for unrelated changes.

Tag: N/A
Commit: N/A
Surfaces: N/A
Result: Not applicable; no mapped OpenCode integration surface changed.

## Public record review

- [ ] The description is understandable without private conversations or local
      environment context.
- [ ] Logs, screenshots, fixtures, and examples are sanitized and contain no
      credentials, personal data, private URLs, or unnecessary machine details.
- [ ] Breaking changes, compatibility effects, and security-sensitive behavior
      are identified where applicable.
- [ ] The diff contains no unrelated generated files or private development
      artifacts.

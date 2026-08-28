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

- [ ] No UI impact, or the applicable rules in `docs/design/ui-standards.md` were checked.
- [ ] `View` contains presentation controls only; full-workspace destinations use `Window`.
- [ ] Every workspace replacement, overlay, and nested detail has an obvious visible exit and keyboard-safe behavior.
- [ ] Controls have accessible names, correct roles, focus behavior, and responsive coverage.

If a contract must change, update the standard, its executable guard, and its regression test in this pull request. Do not bypass the guard with a type assertion or by weakening/removing a test.

## Public record review

- [ ] The description is understandable without private conversations or local
      environment context.
- [ ] Logs, screenshots, fixtures, and examples are sanitized and contain no
      credentials, personal data, private URLs, or unnecessary machine details.
- [ ] Breaking changes, compatibility effects, and security-sensitive behavior
      are identified where applicable.
- [ ] The diff contains no unrelated generated files or private development
      artifacts.

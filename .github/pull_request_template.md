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

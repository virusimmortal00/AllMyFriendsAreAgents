# Non-negotiable UI standards

These are application contracts, not stylistic suggestions. A feature is incomplete if it violates one of them, even when its isolated happy path works. Each rule must be enforced by architecture, an automated test, or both; prose alone is not an enforcement mechanism.

## Contract matrix

| ID | Invariant | Architectural enforcement | Test enforcement |
| --- | --- | --- | --- |
| UI-MENU-001 | `View` changes presentation of the current workspace only. It never navigates or replaces the workspace. | `defineViewMenu` accepts only `presentationCommand` values. | `src/ui-standards.test.tsx` proves workspace commands fail closed in `View`; the App regression test proves Diagnostics is absent. |
| UI-MENU-002 | Whole-workspace destinations live in `Window`, including Chat as the return destination. | `defineWindowMenu` accepts only `workspaceCommand` values. | `src/ui-standards.test.tsx` proves presentation commands fail closed in `Window`; the App regression test opens Diagnostics there. |
| UI-EXIT-001 | Anything that replaces Chat has an obvious, visible way back to Chat. A feature component cannot opt out. | One discriminated workspace state prevents multiple destinations from being active. Its exhaustive renderer puts every replacement inside the required `WorkspaceSurface`, which owns the close control. Workspace names are a closed typed registry. | The production build enforces exhaustive rendering, every registered workspace is exercised by the parameterized UI-standards test, and the App regression test proves the real Diagnostics-to-Chat flow. |
| UI-OVERLAY-001 | Modal overlays have a visible close action, Escape handling, focus containment, focus restoration, and background-scroll locking. | `useModalOverlay` owns the shared interaction behavior. | `src/overlay.test.tsx`, dialog-specific tests, and `src/chrome-safety.test.tsx`. |
| UI-A11Y-001 | Interactive controls have an accessible name and correct semantic role; menu and dialog behavior remains keyboard-operable. | Shared menu, workspace, and overlay primitives own roles and keyboard behavior. | Focused menu/overlay/workspace tests plus Testing Library role queries. |
| UI-RESP-001 | A feature must remain usable at supported narrow and desktop layouts without hiding its only control or exit. | Shared responsive layout primitives and the workspace shell. | `src/mobile-layout.test.ts` plus feature-specific layout tests when a new layout is introduced. |

## Application menu taxonomy

- **You** changes the current member's profile.
- **Room** changes this room or invokes room-scoped actions.
- **View** changes how the current workspace is presented. It does not open another workspace.
- **Window** switches between Chat and whole-workspace destinations.
- **Help** contains documentation and support entry points.

New `View` commands must be created with `presentationCommand`. New full-workspace destinations must be created with `workspaceCommand`, added to `WORKSPACE_NAMES`, and rendered inside the application-owned `WorkspaceSurface`. Product code must not use type assertions to bypass these builders.

## Definition of done for UI changes

1. Reproduce the user-visible failure in a regression test before or alongside the fix.
2. Put cross-cutting behavior in a shared primitive instead of relying on each feature author to remember it.
3. Exercise the real application path, not only the isolated component.
4. Query important controls by accessible role and name in tests.
5. Run `pnpm run check:quality` before review.
6. If the standard itself changes, update this document, the enforcing primitive or validator, and the test in the same pull request.

Deleting, weakening, skipping, or casting around a guard is a contract change and requires explicit review. An unrelated feature change must not do it.

## Merge gate

The `Quality gates / Required quality gates` check runs on every pull request and on `main`. It enforces the focused UI contracts, a strict TypeScript production build, and the entire regression suite. Repository branch protection must mark that check as required; without that administrator setting, GitHub can report a failure but cannot prevent a merge.

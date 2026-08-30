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
| UI-RESP-002 | Every registered view is judged at Phone, Tablet, Short laptop, and Desktop for screen use, navigation, style, proportion, empty space, scroll ownership, and outcome. | `src/view-registry.ts` is the typed identity catalog; shared primitives attach it to rendered roots, and `docs/design/responsive-view-audit.md` is the matching review ledger. | `src/responsive-view-audit.test.ts` fails on code/ledger drift, unattached registry entries, incomplete statuses, schema drift, duplicate IDs/names, or missing P/T/L/D answers. |
| UI-STRUCT-001 | Application windows stay centered and screen-efficient; workspaces use the full allocated canvas; long dialogs separate a scrolling body from persistent actions. | `.desktop`/`.app-window`, `WorkspaceSurface`, `workspace-view`, and `DialogFrame` own those structures. | `src/mobile-layout.test.ts`, `src/layout-structure.test.tsx`, and rendered browser checks for changed layouts. |
| UI-VISUAL-001 | New surfaces preserve the Windows 95/AIM vocabulary: square raised/inset controls, blue title strips, gray chrome, grooved groups, compact typography, classic links, and restrained status colors. Branding and content-specific artwork may remain local. | Shared `classic-*`, dialog, workspace, menu, and status primitives; feature CSS is limited to content-specific composition. | Structure/style contract tests plus P/T/L/D visual review recorded under the affected view IDs. |

## Application menu taxonomy

- **You** changes the current member's profile.
- **Room** changes this room or invokes room-scoped actions.
- **View** changes how the current workspace is presented. It does not open another workspace.
- **Window** switches between Chat and whole-workspace destinations.
- **Help** contains documentation and support entry points.

New `View` commands must be created with `presentationCommand`. New full-workspace destinations must be created with `workspaceCommand`, added to `WORKSPACE_NAMES`, and rendered inside the application-owned `WorkspaceSurface`. Product code must not use type assertions to bypass these builders.

## View identity in code

- Select identities from `VIEWS` in `src/view-registry.ts`; do not repeat an ID, name, or state as a string literal in a component.
- Pass `view` to a shared surface such as `DialogFrame` when that surface owns the view. For other roots, spread `viewAttributes(VIEWS.someView)` on the semantic element that owns its layout and scroll behavior.
- A window receives one primary identity at a time. Attach a second identity to a nested region only when it is a separately reviewed state with its own interaction or scroll contract.
- Keep these attributes diagnostic. Accessible labels remain concise user-facing language, and CSS must not use view IDs as selectors.
- When one DOM composition intentionally represents a named responsive variant, expose that relationship with `data-responsive-view-id`, `data-responsive-view-name`, and `data-responsive-view-state` derived from the registry.

## Definition of done for UI changes

1. Name the affected IDs from `docs/design/responsive-view-audit.md`. Register a genuinely new view in `src/view-registry.ts`, attach it to production markup, and add its matching ledger row as `Pending` before implementing the new layout hierarchy.
2. Reproduce the user-visible failure in a regression test before or alongside the fix.
3. Put cross-cutting behavior in a shared primitive instead of relying on each feature author to remember it.
4. Exercise the real application path, not only the isolated component.
5. Query important controls by accessible role and name in tests.
6. Check Phone, Tablet, Short laptop, and Desktop. Re-answer the seven audit questions for any view whose layout, navigation, interaction hierarchy, or visual primitive changed.
7. Update affected audit outcomes and mark new rows `Complete` only when implementation and evidence are complete.
8. Run `pnpm run check:quality` before review.
9. If the standard itself changes, update this document, the enforcing primitive or validator, and the test in the same pull request.

Deleting, weakening, skipping, or casting around a guard is a contract change and requires explicit review. An unrelated feature change must not do it.

## Merge gate

The `Quality gates / Required quality gates` check runs on every pull request and on `main`. It enforces the focused UI contracts, a strict TypeScript production build, and the entire regression suite. Repository branch protection must mark that check as required; without that administrator setting, GitHub can report a failure but cannot prevent a merge.

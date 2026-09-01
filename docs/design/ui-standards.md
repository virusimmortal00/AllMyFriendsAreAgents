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
| UI-RESP-002 | Every registered view needs rendered evidence and an independent image review for screen use, navigation, style, proportion, empty space, scroll ownership, and outcome. Narrative answers are not visual proof. | `src/view-registry.ts` identifies surfaces; `tests/visual/matrix.ts` declares captured scenarios. The audit records unsupported coverage honestly. | Registry/ledger tests enforce naming only. Browser geometry tests and `check:visual-review` enforce the current capture matrix and image-bound verdicts; uncovered views remain unverified. |
| UI-VISUAL-002 | A screenshot capture or pixel diff is not an agent visual approval. | `review:visual` supplies original PNGs to fresh local Codex sessions, separate from the implementation conversation, and records seven-question verdicts and receipts. | `scripts/visual-review.test.ts` and `scripts/codex-visual-review.test.ts` cover stale/missing/self-approved verdicts, failed geometry/judgments, account-only invocation, image inspection, and process failure. See `docs/testing/visual-review.md`. |
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

### Native scrolling and compact controls

- Control density is shared and selected by input capability, not by viewport
  width, height, or the current view. Standard command buttons use a 26px minimum
  with 12px/16px type for a fine pointer and 44px with 13px/18px type for a coarse
  pointer. Single-line commands keep this height in normal, focused, disabled,
  and pressed states; multiline labels may grow rather than clip. Presence,
  dialog, roster, model-filter, and workspace commands share these tokens.
  Menu items use 20px/44px and their strip reserves four additional pixels for
  chrome; formatting controls use 26px/44px. Resizing must not switch density.
  Width breakpoints may reflow controls, hide the secondary rail, or wrap actions,
  but cannot introduce alternate button/menu heights. Caption controls, tabs,
  list/tile selectors, and palette cells are distinct semantic roles, not ad hoc
  command-button sizes. The informational status strip remains 24px tall.
  Shared browser measurements check every captured view, and a resize regression
  crosses 820/821px, 720/721px, and short-screen boundaries without changing input
  capability. Dialog action rows share eight-pixel insets; wrapping adds only the
  space required for actual content.
  Send shares the composer's command band; the message field uses the full width
  below it, without a reserved side column or a stretched Send button.
- Size surfaces for their task: chat and workspaces use the available canvas;
  short entry, recovery, confirmation, and utility forms remain centered and
  content-sized. Desktop background around a focused utility window is intentional.
  Do not stretch a small form into an empty full-height window merely to consume
  the viewport; assess its internal proportions, readability, and reachable actions.
- Use native scrolling, with a bounded content region and persistent navigation
  and actions. An overflowing pane needs a visible affordance even on platforms
  that hide overlay scrollbars. Shared CSS gives the real browser scrollbar
  neutral gray colors while preserving native behavior. Fine-pointer layouts
  expose a 14px classic track with a raised thumb where native scrollbar parts
  can be styled; touch layouts retain their platform scrollbar sizing.
  Do not mix non-auto `scrollbar-color` with native scrollbar-part styling: the
  former overrides the latter. A stable native gutter prevents
  content-width jumps when overflow changes. The thumb communicates position
  and remaining content without a separate instruction or end-of-content row.
  On platforms that still hide the track, `useScrollEdges` adds a small inset
  shadow at only the edges with more content. Unlike a content mask, an inset
  shadow [paints below text and controls](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/box-shadow).
  It decorates the actual scroll owner,
  occupies no layout space, and disappears at the corresponding end. It does not
  render a component, rerender the page on scroll, or intercept input. Forced
  colors omit the shadow and retain system-colored native scrolling.
  Do not add a fake scrollbar, wheel/touch handler, a mask over readable controls,
  scroll snapping, or labels such as “Scroll down for more.” Native input behavior
  remains intact. Forced colors use system colors, and `classic-scroll-region`
  contains overscroll. Verify actual gutters or directional edges and first/last-item access
  in the browser, not only CSS declarations.
- Distinguish content crossing a clearly indicated scroll boundary from content
  clipped inside its own row or control. The latter is a defect; the former
  requires scroll affordance and interaction evidence that the content is reachable.
- Group boxes should identify meaningful sections. Do not wrap already-grouped
  form controls in another unlabelled frame that consumes width and height without
  adding hierarchy, particularly inside a narrow detail pane.
  Keep layout-only wrappers borderless; use compact spacing or a single separator
  between adjacent groups. Reserve raised edges for window chrome and actions,
  inset edges for input/collection surfaces, and grooves for meaningful named
  groups. Do not stack window, body, pane, and section bevels around the same
  content. Manage Agents enforces this distinction in rendered browser checks.
  A fitting detail pane ends at its content instead of stretching an empty inner
  frame to match a longer neighboring list. Keep scroll owners separate from
  inline-size query containers so native gutters participate in sizing correctly.
  The two-column roster editor uses a responsive working height that is slightly
  taller than the underlying chat pane, bounded by the viewport and capped for
  large displays. Use that allocation to expose more collection rows; do not
  stretch a framed detail form or let item count determine window height.
  Size-contain the neighboring collection so its native scroll exposes remaining
  items. Keep actions directly beneath the workspace.
  Use the same gray property-sheet surface around the form, not a contrasting
  white workspace. Single-pane phone layouts still use the available viewport.
- Use compact property-sheet rows for short label/control pairs (`classic-property-row`).
  Long settings forms use `classic-property-section` for compact headings and
  text, with separators between sections rather than nested full frames.
  Every page in one property sheet uses the same content padding, field rhythm,
  typography, and control sizing. The selected tab keeps raised top and side
  edges but omits its bottom edge so it merges into the page surface. Inactive
  tabs use the light sheet baseline instead of a button-like dark lower edge.
  `classic-field-heading` places a field's reset action beside its label, outside
  the label element; it does not stretch the action across the editor width.
  Prompt editors start at a compact, readable height and remain natively resizable.
  Consolidate duplicate identity summaries; keep model maker and access provider
  explicit. Lay out small permission sets in columns when their labels fit, while
  preserving touch targets and full explanations. Default forms should fit the
  regular phone and short-laptop checkpoints where practical. Smaller heights,
  expanded pickers, and additional diagnostic content may scroll; do not hide
  information or shrink controls merely to force every state onto one screen.
  Stack a destructive action below its explanation when the detail pane is too
  narrow for both; do not leave the explanation in a squeezed side column.
- Full-width text-field rules must exclude checkbox/radio inputs. `classic-check`
  keeps the real checkbox input compact and adjacent to its label; the label
  provides the larger touch target. Its shared square, inset decoration follows
  the input's checked, disabled, focus-visible, and forced-color states. Preserve
  native keyboard and label behavior; never replace the input with a painted div.
  The focus ring must contrast on both gray surfaces and blue policy headers.
  Reflow dense settings based on pane width, not only viewport width.
- Primary agent aliases wrap in compact rosters so identities remain readable.
  Secondary model/provider metadata may use explicit ellipsis in a master list
  when the complete value is available in its detail view. Do not shrink primary
  names or expand every secondary value into a dense paragraph to avoid ellipsis.
- Composer formatting controls reflow within the available width. Do not hide
  actions in an unmarked horizontal scroller; every control must fit its toolbar
  and remain reachable at the minimum viewport. Presence-rail rows likewise use
  intrinsic height when a primary name wraps.
- Shared dialog and workspace frames use the same native scrollbar treatment for
  their content regions, including nested tab pages. Each pane owns its own
  scrollbar; a footer must not describe overflow in another pane.
  Color, smiley, and mention popovers retain a
  visible close control; mentions sit above rather than over the composer toolbar.
  Color and smiley popovers use the shared `classic-popover` frame: persistent
  header and independently scrolling body with a native scrollbar when needed.
  The frame stacks these regions with flex layout so the body reflows within
  the native gutter as available height changes; do not clip horizontal overflow
  to conceal a scrollbar-width sizing defect.
  Bound them to the available visual viewport, not a percentage cap that creates
  needless scrolling when all choices could fit. Every swatch remains reachable
  when the available height shrinks.
  Position formatting popovers above or below the entire toolbar, not only the
  triggering button's row, so wrapped font controls remain exposed when space permits.
  Native dropdowns use `classic-select` for square inset styling and shared touch
  sizing. Keep the real select, platform picker, and keyboard behavior; use native
  appearance in forced colors rather than replacing selection with a custom menu.
- Tabbed property sheets use `DialogFrame`'s `property-sheet` layout: one stable,
  centered frame for all pages, bounded by the viewport, with matching action
  placement. Changing tabs must not move or resize the window. Inactive pages
  remain mounted to preserve drafts but must not paint, take layout space, or
  accept focus; shared `[hidden]` enforcement takes precedence over grid/flex
  declarations. Verify the round trip after the longer page loads, not just
  separate initial screenshots of each page.
- Sparse lists and not-yet-loaded results use bounded, inset content areas with
  explicit state text. Do not leave an accidental unused grid column or fixed-width
  result strip in a full-width workspace. Model selectors use the same square,
  raised/inset surfaces as other classic dialogs. Filters wrap on wider surfaces;
  compact pickers use a native filter dropdown beside Sort so controls do not
  consume the entire view. Embedded pickers share their settings page's native
  scroll owner and retain a visible route back to the form. Model-result columns
  size intrinsically to the actual pane width, rather than forcing two cards into
  a narrow tablet pane. Status badges wrap with explicit spacing from titles.
- Populated lists show a truthful count of the results currently rendered. Fitting
  content needs neither a scrollbar nor an “all shown” status row. Do not manufacture
  rows or enlarge controls to fill unused collection space. Selectable task and
  contribution titles use conventional classic link styling, including a readable
  selected/hover state. Short missing-record recovery omits unrelated controls.
- Keep full-size workspaces centered on the available canvas, but let their
  content panels end where the content ends. `workspace-content` bounds operational
  lists and Improvements on a gray workspace canvas; shared Tasks/Contributions
  lists also retain their intrinsic height. Do not stretch a white inset list into empty
  screen space. Diagnostics use an adjacent result list and detail when the pane
  permits, stack them on narrow panes, and size payloads to their actual text.
  Recovery panels remain content-sized and centered within the gray workspace.

1. Name the affected IDs from `docs/design/responsive-view-audit.md`. Register a genuinely new view in `src/view-registry.ts`, attach it to production markup, and add its matching ledger row as `Pending` before implementing the new layout hierarchy.
2. Reproduce the user-visible failure in a regression test before or alongside the fix.
3. Put cross-cutting behavior in a shared primitive instead of relying on each feature author to remember it.
4. Exercise the real application path, not only the isolated component.
5. Query important controls by accessible role and name in tests.
6. Check Phone, Tablet, Short laptop, and Desktop. Re-answer the seven audit questions for any view whose layout, navigation, interaction hierarchy, or visual primitive changed.
7. Update affected audit outcomes. Inventory rows remain `Pending` or `Unverified`; a current capture manifest plus a passing independent image-review record is the visual evidence, not a handwritten `Complete` label.
8. Run `pnpm run check:quality` before review.
9. If the standard itself changes, update this document, the enforcing primitive or validator, and the test in the same pull request.

Deleting, weakening, skipping, or casting around a guard is a contract change and requires explicit review. An unrelated feature change must not do it.

## Merge gate

The `Quality gates / Required quality gates` check runs on every pull request and on `main`. It enforces the focused UI contracts, a strict TypeScript production build, and the entire regression suite. Repository branch protection must mark that check as required; without that administrator setting, GitHub can report a failure but cannot prevent a merge.

The separate `Visual evidence` workflow captures deterministic screenshots and runs real-browser layout assertions. Its green result means **capture/layout passed**, not **visual approval**. Before approving UI work, run the local, account-backed `pnpm review:visual --run <capture-directory>`, then `pnpm check:visual-review` against its exact evidence. Fresh Codex sessions inspect attached originals without the implementation conversation. Account-backed review must not run in public CI; GitHub only captures screenshots. This is an enforced contributor workflow, not a claimed GitHub-required visual approval check. Invocation requires permission to consume the signed-in account's Codex allowance; unavailable authentication or quota is a failure, never a reason to skip review or use API billing.

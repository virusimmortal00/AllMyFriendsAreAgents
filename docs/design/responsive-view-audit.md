# Responsive view audit

This file is the canonical review ledger for the application-wide responsive UI review. The matching typed identity catalog lives in `src/view-registry.ts`; the validator requires both sources to contain the same IDs, names, states, and order. Together they name every distinct user-facing screen, workspace, dialog, and interactive overlay that requires its own layout judgment. A row is complete only after the view has been checked at every representative viewport and the final questions below have explicit answers.

## Maintenance contract

Treat the IDs and names in `src/view-registry.ts` and this ledger as stable product vocabulary. Use them in issues, pull requests, tests, screenshots, and review notes so a phrase such as “ROOM-02 at Short laptop” identifies one reproducible layout without relying on private context. Rendered view roots expose the same identity through `data-view-id`, `data-view-name`, and `data-view-state`, which makes browser evidence and automated checks traceable back to this ledger.

Before implementing a new user-facing view or materially distinct state:

1. Decide whether it is a new view, a state of an existing view, or a reusable overlay. A new navigation destination, layout hierarchy, primary task, or scroll owner requires a new ID. Loading, empty, failure, and success presentations that retain the same hierarchy normally remain named states of one ID.
2. Add the proposed ID, name, state, and category to `src/view-registry.ts`, then add the identical ID, name, and state to this inventory with status `Pending`. Attach the registry entry to the rendered root through a shared primitive or `viewAttributes`. IDs are never reused or renumbered, even if a view is later removed; record removed IDs in a short retirement note instead.
3. Follow the existing naming grammar: concise title case for the user-facing object or task, an em dash for a property page or integration state, and a distinct-state description that says what changes without restating the name.
4. Build with the shared app-frame, workspace, dialog, tabs, group-box, summary, status, and action-strip primitives. Add a primitive when behavior is cross-cutting instead of copying feature-local window CSS.
5. Check Phone, Tablet, Short laptop, and Desktop and answer all seven questions. Record viewport-specific differences explicitly with `P`, `T`, `L`, and `D` prefixes.
6. Mark the row `Complete` only after the implementation, responsive evidence, focused regression test, and `pnpm run check:ui-standards` all pass.

`src/responsive-view-audit.test.ts` enforces registry/ledger parity, production-code attachment, unique stable IDs, complete inventory/audit pairing, the seven-question schema, and explicit P/T/L/D coverage. It intentionally cannot decide whether an unregistered design is “new”; that judgment remains a required author and reviewer check.

## Representative viewports

| Name | Size | Purpose |
| --- | --- | --- |
| Phone | 390 × 844 | Narrow touch layout and safe-area behavior |
| Tablet | 768 × 1024 | Intermediate layout, touch targets, and line length |
| Short laptop | 1024 × 600 | Limited vertical space with desktop navigation |
| Desktop | 1440 × 900 | Large-screen density, hierarchy, and maximum line length |

These are representative checkpoints, not device-specific designs. Layouts must also behave continuously between them and down to the supported 320-pixel minimum width.

## Questions answered for every view

1. Does it make effective use of the available screen without feeling crowded or sparse?
2. Is the primary navigation and the way out obvious and easy to operate?
3. Does it preserve the application’s Windows 95/AIM visual language?
4. Are controls, type, panels, and whitespace proportionate to the viewport?
5. Is any empty area intentional and compositionally useful?
6. Is scrolling owned by the correct region, with important actions remaining reachable?
7. What changed, or why is no change needed?

## Inventory and completion status

### Application and chat

| ID | Named view | Distinct state | Status |
| --- | --- | --- | --- |
| APP-01 | Startup | Initial server loading | Complete |
| APP-02 | Join Room | First-time name entry | Complete |
| APP-03 | Join Recovery | Join failure, retry, and cancel | Complete |
| CHAT-01 | Room Chat | Transcript, composer, status bar, and desktop Who’s Here rail | Complete |
| CHAT-02 | Compact Room Chat | Narrow chat with room controls available through menus | Complete |
| CHAT-03 | Room Menu | Room-scoped command menu | Complete |
| CHAT-04 | Window Menu | Workspace switcher and return-to-chat navigation | Complete |
| CHAT-05 | Mention Suggestions | Composer mention results | Complete |
| CHAT-06 | Text Color Palette | Message text-color picker | Complete |
| CHAT-07 | Highlight Color Palette | Message highlight-color picker | Complete |
| CHAT-08 | Classic Smiley Picker | AIM smiley picker | Complete |
| CHAT-09 | Poll Cards | Active room poll and voting states | Complete |
| CHAT-10 | Pending Send Recovery | Ambiguous-send recovery bar | Complete |
| CHAT-11 | Connection and Action Notices | Reconnect, pending action, and dismissible error strips | Complete |

### Full workspaces

| ID | Named view | Distinct state | Status |
| --- | --- | --- | --- |
| WORK-01 | Improvements List | Active and All list tabs, including empty/loading/error | Complete |
| WORK-02 | Improvement Detail | Existing improvement record | Complete |
| WORK-03 | Improvement Not Found | Missing improvement recovery | Complete |
| WORK-04 | Room Tasks List | Task list, empty, loading, and create form | Complete |
| WORK-05 | Room Task Detail | Selected task editor and history | Complete |
| WORK-06 | Durable Continuations | Policy control, dashboard, and continuation inbox | Complete |
| WORK-07 | Background Investigations | Policy control, investigation lanes, and findings | Complete |
| WORK-08 | Reviewed Contributions List | Contribution list, empty, loading, and notices | Complete |
| WORK-09 | Reviewed Contribution Detail | Review gates and contribution detail | Complete |
| WORK-10 | Owner Diagnostics Query | Bounded diagnostic search controls | Complete |
| WORK-11 | Owner Diagnostics Results | Result list and selected diagnostic detail | Complete |

### Room and participant dialogs

| ID | Named view | Distinct state | Status |
| --- | --- | --- | --- |
| ROOM-01 | Room Properties — General | Room name, topic, and conversation energy | Complete |
| ROOM-02 | Room Properties — Agent Behavior | Base prompt, summarizer, and routing | Complete |
| ROOM-03 | Room Summarizer Model Picker | Lazy-loaded model search, filters, and results | Complete |
| ROOM-04 | Manage Room Agents — Sign In | Server-administrator authentication gate | Complete |
| ROOM-05 | Manage Room Agents — Roster | Agent list, sorting, availability, and mobile master pane | Complete |
| ROOM-06 | Manage Room Agents — Agent Detail | Selected agent identity, provider, model, and permissions | Complete |
| ROOM-07 | Manage Room Agents — Model Picker | Provider/model selection and model detail | Complete |
| ROOM-08 | Manage Room Agents — Conflict | Save conflict and recovery | Complete |
| ROOM-09 | Unsaved Changes Confirmation | Destructive-close confirmation | Complete |
| PERSON-01 | Your Profile | Name and avatar editor | Complete |
| PERSON-02 | Agent Status | Individual agent availability, provider health, and recovery | Complete |

### GitHub integration

| ID | Named view | Distinct state | Status |
| --- | --- | --- | --- |
| GH-01 | GitHub — Administrator Sign In | Existing server-owner authentication | Complete |
| GH-02 | GitHub — Claim Owner | First-time server-owner setup | Complete |
| GH-03 | GitHub — Connect Account | No connected GitHub account | Complete |
| GH-04 | GitHub — Device Authorization | User code and GitHub handoff | Complete |
| GH-05 | GitHub — Choose Project Repository | Connected account with repository selection | Complete |
| GH-06 | GitHub — Configured Repository | Connected and configured summary | Complete |
| GH-07 | GitHub — Empty Repository Access | No repositories available and recovery action | Complete |

### Supporting dialogs

| ID | Named view | Distinct state | Status |
| --- | --- | --- | --- |
| AUX-01 | Improvement Workshop | Loaded improvement facts and evidence | Complete |
| AUX-02 | Improvement Workshop Recovery | Loading, unavailable, missing, and retry states | Complete |
| AUX-03 | Help | Navigation and room help topics | Complete |
| AUX-04 | Confirmation | Shared confirm/cancel alert dialog | Complete |

## Completed audits

The tables below use **P / T / L / D** for Phone, Tablet, Short laptop, and Desktop. Every cell explicitly applies its answer to all four checkpoints; a named checkpoint records an intentional difference. “Pass” means the question was answered positively after inspecting the rendered layout, the responsive DOM/CSS contract, or both. State-only variants that cannot be produced safely against a live room were rendered in their component tests and checked against the same shared layout rules.

### Application and chat audit

| ID | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll and actions | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| APP-01 | P/T/L/D: Pass; compact centered loading window. | P/T/L/D: Waiting state is explicit; recovery supplies actions. | P/T/L/D: Pass; title bar, inset panel, dotted spinner. | P/T/L/D: Content-sized rather than stretched. | P/T/L/D: Teal surround is intentional focus space. | P/T/L/D: No scroll needed; recovery actions remain visible. | P/T/L/D: No additional change. |
| APP-02 | P/T/L/D: Pass; join form is centered and content-sized. | P/T/L/D: Single Enter room path is obvious. | P/T/L/D: Pass; classic input and raised default button. | P/T/L/D: Phone form narrows without becoming a card stack. | P/T/L/D: Outer teal space intentionally isolates entry. | P/T/L/D: No scroll at checkpoints; submit remains visible. | P/T/L/D: No additional change. |
| APP-03 | P/T/L/D: Pass; recovery copy and controls use the compact loader. | P/T/L/D: Retry now and Use a different name provide both exits. | P/T/L/D: Pass; recovery stays inside the same classic window. | P/T/L/D: Buttons wrap only when needed. | P/T/L/D: Remaining surround is intentional. | P/T/L/D: Actions remain reachable; retry busy state is clear. | P/T/L/D: No additional change. |
| CHAT-01 | P: Pass with menu-based room controls; T/L/D: Pass with transcript plus Who’s Here rail. | P/T/L/D: Top menus persist; Window destinations return through Chat/close. | P/T/L/D: Pass; AIM transcript inside Windows chrome. | P: One-column chat; T/L: 240px rail; D: capped 1400px shell. | P/T/L/D: Transcript receives flexible space; no unused grid track. | P/T/L/D: Transcript owns scroll; composer and status remain fixed. | P/T/L/D: Fixed shared frame centering and tablet touch sizing. |
| CHAT-02 | P: Pass at 378×832 with 6px equal margins; T/L/D: shared shell also centered. | P/T: 40px menu targets; L/D: compact desktop menus. | P/T/L/D: Pass; restored visible desktop/window silhouette. | P: Uses 96.9% width and 98.6% height; T/L/D: proportional caps. | P/T/L/D: No accidental edge gap or dead inner area. | P/T/L/D: No page overflow; transcript owns vertical scroll. | P: Replaced top-left 100dvh block layout with centered safe-area grid; T/L/D: retained centered capped frame. |
| CHAT-03 | P/T: Pass with 40px commands; L/D: pass with compact commands. | P/T/L/D: Room-scoped labels, disabled states, outside-click and Escape. | P/T/L/D: Pass; conventional menu and separators. | P/T: Wide enough for command labels; L/D: content-sized. | P/T/L/D: No decorative empty rows. | P/T/L/D: Dropdown is the owning overlay and remains in viewport. | P/T: Enlarged touch targets; L/D: no change. |
| CHAT-04 | P/T: Pass with 40px destinations; L/D: compact workspace menu. | P/T/L/D: Current view marked and Chat is a persistent return path. | P/T/L/D: Pass; shared classic menu. | P/T/L/D: Labels fit without horizontal scrolling. | P/T/L/D: No unused menu space. | P/T/L/D: Menu remains viewport-contained. | P/T: Enlarged targets; L/D: retained compact commands; all sizes use unified workspace shell. |
| CHAT-05 | P/T/L/D: Pass; suggestions use available composer width with a cap. | P/T/L/D: Keyboard selection, click selection, and dismissal are clear. | P/T/L/D: Pass; raised suggestion window and blue selection. | P/T/L/D: One-line identities truncate safely. | P/T/L/D: Result height is content-driven and capped. | P/T/L/D: Results scroll independently above the composer. | P/T/L/D: No additional change. |
| CHAT-06 | P/T/L/D: Pass; palette is anchored above the toolbar and viewport-capped. | P/T/L/D: Trigger, swatches, pressed state, and dismissal are clear. | P/T/L/D: Pass; classic raised palette and inset selection. | P/T: Larger swatches; L/D: dense 8-column palette. | P/T/L/D: Palette height follows its content. | P/T/L/D: Palette scrolls internally when vertically constrained. | P/T/L/D: Retained shared fixed-position overlay behavior. |
| CHAT-07 | P/T/L/D: Pass; shares Text Color geometry. | P/T/L/D: Highlight trigger and selected swatch are explicit. | P/T/L/D: Pass; same palette primitive. | P/T: Touch-sized swatches; L/D: compact density. | P/T/L/D: No accidental empty panel. | P/T/L/D: Internal scroll prevents composer clipping. | P/T/L/D: Retained shared palette primitive. |
| CHAT-08 | P/T/L/D: Pass; picker is small and anchored above toolbar. | P/T/L/D: Smiley buttons and outside/Escape dismissal are clear. | P/T/L/D: Pass; pixelated AIM assets in a raised palette. | P/T: 38px buttons; L/D: 34px dense buttons. | P/T/L/D: Four-column grid is content-sized. | P/T/L/D: Picker stays above clipping boundary. | P/T/L/D: No additional change. |
| CHAT-09 | P/T/L/D: Pass; polls occupy transcript width without taking over the window. | P/T/L/D: Vote, recorded choice, tally, and owner close are explicit. | P/T/L/D: Pass after inset white poll surface and raised choices. | P/T: 42px choices; L/D: compact 25px choices. | P/T/L/D: Card height follows options and status. | P/T/L/D: Poll stack participates in transcript scrolling. | P/T/L/D: Replaced modern flat card treatment with classic inset/raised controls. |
| CHAT-10 | P/T/L/D: Pass; recovery strip uses composer width. | P/T/L/D: Send now and Keep as draft are both explicit. | P/T/L/D: Pass; yellow system strip and raised buttons. | P: Copy receives its own row; T/L/D: compact three-column strip. | P/T/L/D: No accidental blank area. | P/T/L/D: Strip remains above composer and buttons stay reachable. | P/T/L/D: No additional change. |
| CHAT-11 | P/T/L/D: Pass; notices overlay or occupy a dedicated grid row. | P/T/L/D: Retry and dismiss controls are explicit when safe. | P/T/L/D: Pass; yellow pending and red failure system colors. | P: Error strip is capped and scrollable; T/L/D: compact. | P/T/L/D: No persistent space when notices are absent. | P/T/L/D: Long phone notices scroll locally; app shell never scrolls. | P/T/L/D: No additional change. |

### Full-workspace audit

| ID | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll and actions | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WORK-01 | P/T/L/D: Pass; list now uses the complete workspace width. | P/T/L/D: Active/All tabs plus workspace close/Chat return. | P/T/L/D: Pass; blue title strip, inset white list. | P: single-column rows and 42px tabs; T/L/D: denser list columns. | P/T/L/D: Empty/loading/error space is intentionally within the list pane. | P/T/L/D: Body is the only scrolling region. | T/L: Removed accidental empty 240px rail track; P/D: retained existing full-width behavior. |
| WORK-02 | P/T/L/D: Pass; detail fills the same shared workspace. | P/T/L/D: Breadcrumb plus visible workspace close/Chat return. | P/T/L/D: Pass; classic links, definition list, title strip. | P: status definitions stack; T/L/D: label/value grid. | P/T/L/D: Readable line length is intentional, not a missing pane. | P/T/L/D: Detail scrolls inside workspace body. | T/L: Applied full-width selector fix; P/D: no further change. |
| WORK-03 | P/T/L/D: Pass; recovery stays focused and does not stretch copy. | P/T/L/D: Active and All recovery buttons plus workspace close. | P/T/L/D: Pass; standard error/recovery treatment. | P/T/L/D: 600px readable cap on large screens; full usable width when narrow. | P/T/L/D: Remaining white area communicates an empty result. | P/T/L/D: Buttons remain in the scrolling body and are immediately visible. | T/L: Applied full-width selector fix; P/D: retained state layout. |
| WORK-04 | P/T/L/D: Pass; task create form and list use full workspace. | P/T/L/D: Window/close return; create and list actions are explicit. | P/T/L/D: Pass; inset forms, classic list selection. | P: form stacks; T/L/D: compact title/action grid. | P/T/L/D: Empty-task panel is intentionally bounded. | P/T/L/D: Task body owns scroll; sticky notices remain visible. | T/L: Removed empty rail track; P/D: retained existing responsive compositions. |
| WORK-05 | P/T/L/D: Pass; selected task uses full workspace. | P/T/L/D: Back to list and workspace close are visible. | P/T/L/D: Pass; shared task states, inset sections, raised actions. | P: edit/actions/columns stack; T/L/D: columns use width. | P/T/L/D: Evidence/history whitespace supports scanning. | P/T/L/D: One body scroll contains editor and history. | T/L: Applied full-width fix; P/D: retained action and column behavior. |
| WORK-06 | P/T/L/D: Pass; continuation cards use complete workspace. | P/T/L/D: Policy control, job actions, inbox actions, and close are visible. | P/T/L/D: Pass; blue header, inset cards, classic buttons. | P: 104px wrapped header; T: 55px; L/D: 41px. | P/T/L/D: Empty inbox/job state is intentional. | P/T/L/D: Cards and inbox entries scroll in shared body. | T/L: Applied full-width fix; P/D: retained shared header compositions. |
| WORK-07 | P/T/L/D: Pass; same complete workspace contract as continuations. | P/T/L/D: Policy, cancel/resume, inbox acknowledge/close, workspace close. | P/T/L/D: Pass; shared operational workspace styling. | P: wrapped header; T/L/D: compact proportional header. | P/T/L/D: Empty investigation state is intentional. | P/T/L/D: Body owns job and finding scroll. | T/L: Applied full-width fix; P/D: retained header and touch behavior. |
| WORK-08 | P/T/L/D: Pass; contribution list fills workspace. | P/T/L/D: Row selection and workspace close are clear. | P/T/L/D: Pass; classic list and notice/error strips. | P: list metadata stacks; T/L/D: compact rows. | P/T/L/D: Empty handoff message is an intentional bounded state. | P/T/L/D: Body owns list scroll. | T/L: Applied full-width fix; P/D: retained stacked and dense list behavior. |
| WORK-09 | P/T/L/D: Pass; review detail uses full workspace. | P/T/L/D: Back to list, gated actions, and workspace close are visible. | P/T/L/D: Pass; five-step classic review status. | P: five steps stack; T/L/D: five equal columns. | P/T/L/D: Gate spacing is informational and intentional. | P/T/L/D: Detail body owns scroll and actions stay reachable. | T/L: Applied full-width fix; P/D: retained step layouts. |
| WORK-10 | P/T/L/D: Pass; bounded query controls receive full workspace. | P/T/L/D: Query action, Window/close return, and labels are clear. | P/T/L/D: Pass; compact owner-tool styling inside shared chrome. | P: controls wrap naturally; T/L/D: compact row. | P/T/L/D: Pre-query empty area communicates that nothing loads implicitly. | P/T/L/D: Body owns results; page never scrolls. | T/L: Removed unused right track; P/D: retained existing query layout. |
| WORK-11 | P/T/L/D: Pass; results/detail use the full workspace canvas. | P/T/L/D: Result selection and workspace close/Chat return are clear. | P/T/L/D: Pass; inset result buttons and diagnostic detail. | P: records stack; T/L/D: 720px readable evidence width avoids extreme lines. | P/T/L/D: Extra wide-screen space is intentional readability protection. | P/T/L/D: Results/detail scroll inside the workspace body; preformatted content scrolls locally. | T/L: Applied full-width fix; P/D: retained readable evidence cap. |

### Room and participant dialog audit

| ID | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll and actions | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ROOM-01 | P: 376×513 centered; T/L/D: compact 600px property sheet. | P/T/L/D: General/Agent behavior tabs plus OK, Cancel, Apply, close. | P/T/L/D: Pass; historical tabbed property-sheet convention. | P: 40px tabs and 70px wrapped actions; T: 40px controls; L/D: dense controls. | P/T/L/D: Dialog height follows content; no gray moat. | P/T/L/D: Content owns scroll and action strip is persistent. | P/T/L/D: Unified former settings/properties entry into General property page. |
| ROOM-02 | P: near-full 376×830; T: 736×981; L: 900×568; D: 900×868. | P/T/L/D: Same tabs, close, persistent OK/Cancel/Apply. | P/T/L/D: Pass; grooved group boxes inside property sheet. | P/T/L/D: Long editor appropriately expands while respecting margins. | P/T/L/D: Space is consumed by actual editor content. | P/T/L/D: Independent content scroll; actions always visible. | P/T/L/D: Lazy loading plus fixed action strip; no client-timeout race. |
| ROOM-03 | P/T/L/D: Pass; picker expands within Summarizer group, not beyond dialog. | P/T/L/D: Choose/Hide, filters, model result, and tab/close remain available. | P/T/L/D: Pass; inset results and raised selection controls. | P: one-column filters/results; T/L/D: richer grid. | P/T/L/D: Catalog empty/loading/error states occupy only their content region. | P/T/L/D: Picker and property content have bounded scroll ownership. | P/T/L/D: Models now load only on demand with 15s timeout and retry. |
| ROOM-04 | P: 362×465 centered; T/L/D: compact 640px sign-in window. | P/T/L/D: Sign in and Cancel/close are obvious; disabled state explains readiness. | P/T/L/D: Pass; grooved authentication group and classic inputs. | P/T: touch-height fields; L/D: compact fields. | P/T/L/D: Removed full-roster-sized blank canvas. | P/T/L/D: Content-sized at checkpoints; body can scroll if localization grows. | P/T/L/D: Added authentication presentation and removed meaningless Save roster action. |
| ROOM-05 | P: single-pane roster master; T/L/D: list/detail split using available width. | P: row opens detail and Your agents returns; T/L/D: persistent rail; Cancel/Save fixed. | P/T/L/D: Pass after replacing rounded cards/pills/blue app buttons with inset/raised chrome. | P: full-height 14px margins; T/L/D: 270–330px master plus flexible detail. | P/T/L/D: Empty roster provides a guided three-step path, not blank space. | P/T/L/D: Master and detail own scroll; footer actions persist. | P/T/L/D: Responsive master/detail plus classic visual normalization. |
| ROOM-06 | P: detail replaces list; T/L/D: detail sits beside roster. | P: visible Your agents back; T/L/D: persistent roster rail; all sizes expose activation, model, permissions, delete, Cancel/Save. | P/T/L/D: Pass; native checkbox, groove groups, inset model summary. | P: fields and danger zone stack; T/L/D: proportional split header. | P/T/L/D: Group spacing communicates settings hierarchy. | P/T/L/D: Detail pane owns scroll; global actions remain fixed. | P/T/L/D: Removed modern switch, rounded cards, and shadowed summary. |
| ROOM-07 | P: one-column model results; T/L/D: responsive multi-column catalog. | P/T/L/D: Step heading, filters, selection, back/change-model actions. | P/T/L/D: Pass; classic result/summary surfaces with local provider marks. | P/T/L/D: Catalog height capped relative to dialog. | P/T/L/D: Empty/error catalog states are explicit. | P/T/L/D: Model results scroll locally; roster actions remain fixed. | P/T/L/D: Shared responsive model picker retained inside classic roster shell. |
| ROOM-08 | P/T/L/D: Pass; conflict notice occupies roster error row without replacing draft. | P/T/L/D: Load latest roster, Cancel, and close behavior are explicit. | P/T/L/D: Pass; classic red notice and raised recovery. | P/T/L/D: Notice wraps within dialog width. | P/T/L/D: No reserved conflict space when absent. | P/T/L/D: Notice/action remain outside master/detail scroll. | P/T/L/D: No additional change. |
| ROOM-09 | P/T/L/D: Pass; confirmation is content-sized and centered. | P/T/L/D: Cancel and discard action are explicit; no ambiguous close control. | P/T/L/D: Pass; alert dialog in shared classic frame. | P/T: buttons wrap/touch-size; L/D: compact action row. | P/T/L/D: No unused interior area. | P/T/L/D: Description scrolls only if needed; actions remain fixed. | P/T/L/D: Shared DialogFrame retained. |
| PERSON-01 | P: 376×309; T/L/D: 480×280 centered. | P/T/L/D: Save/Cancel/close and avatar edit controls are explicit. | P/T/L/D: Pass; classic dialog chrome with identity artwork local to profile. | P: 54px avatar and stacked actions; T/L/D: 64px avatar. | P/T/L/D: Content-sized with balanced surrounding space. | P/T/L/D: No scroll at checkpoints; actions fixed. | P/T/L/D: Verified shared centered frame; no additional change. |
| PERSON-02 | P/T/L/D: Pass; 470px content-sized status window. | P/T/L/D: Close and bounded provider retry are explicit. | P/T/L/D: Pass; group box, state lamp, classic close action. | P/T: touch close; L/D: compact. | P/T/L/D: Remaining fieldset space is informational. | P/T/L/D: Dialog body owns overflow; close action remains fixed. | P/T/L/D: Shared DialogFrame retained. |

### GitHub integration audit

| ID | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll and actions | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GH-01 | P: 376×357; T/L/D: 640×318 centered. | P/T/L/D: Sign in, Close, and title-bar close are clear. | P/T/L/D: Pass; grooved admin group and classic form controls. | P/T: touch fields/actions; L/D: compact 12px dialog typography. | P/T/L/D: Content-sized; no full-editor blank canvas. | P/T/L/D: No scroll at checkpoints; actions persist. | P/T/L/D: Adapted sibling work into shared dialog/group primitives. |
| GH-02 | P/T/L/D: Pass; claim fields remain in compact auth dialog. | P/T/L/D: Claim owner and Close are explicit; unavailable bootstrap explains itself. | P/T/L/D: Pass; same classic auth group. | P/T: stacked touch controls; L/D: compact form. | P/T/L/D: No reserved integration panels behind setup. | P/T/L/D: Dialog body can scroll; actions remain fixed. | P/T/L/D: Shared authentication presentation retained. |
| GH-03 | P/T/L/D: Pass; two concepts only: account and project repository. | P/T/L/D: Connect account, conventional links, and Close are explicit. | P/T/L/D: Pass; official mark local, group boxes/status lamp shared. | P: two-column account summary collapses cleanly; T/L/D: compact row. | P/T/L/D: Removed redundant third panel and internal metadata. | P/T/L/D: Body owns overflow; close fixed. | P/T/L/D: Adopted clearer connection state and simplified hierarchy. |
| GH-04 | P/T/L/D: Pass; authorization code and handoff fit their group. | P/T/L/D: GitHub handoff link, refresh/status, and Close are clear. | P/T/L/D: Pass; inset yellow challenge and classic links. | P: challenge wraps vertically; T/L/D: horizontal where space allows. | P/T/L/D: Waiting state uses only necessary space. | P/T/L/D: Body scrolls if provider copy expands. | P/T/L/D: Removed token/encryption/credential implementation language. |
| GH-05 | P/T/L/D: Pass; repository chooser occupies the project group only. | P/T/L/D: Repository select/use, access link, and Close are explicit. | P/T/L/D: Pass; inset repository field and raised action. | P/T: full-width select/action; L/D: concise row. | P/T/L/D: No disabled configured-state selector. | P/T/L/D: Body owns overflow; actions remain reachable. | P/T/L/D: Collapsed integration to account and repository concepts. |
| GH-06 | P/T/L/D: Pass; concise configured repository summary replaces form. | P/T/L/D: Repository link, access link, and Close are conventional. | P/T/L/D: Pass; square green status lamp, inset summary, Primer mark. | P: summary collapses to icon/path then status; T/L/D: compact three-column row. | P/T/L/D: No redundant selector or revision metadata. | P/T/L/D: Long paths wrap; dialog body remains bounded. | P/T/L/D: Added repository normalization for correct path and URL. |
| GH-07 | P/T/L/D: Pass; empty-access explanation stays in project group. | P/T/L/D: Repository access/retry action and Close are explicit. | P/T/L/D: Pass; classic group and raised recovery. | P: action becomes full-width; T/L/D: content-sized. | P/T/L/D: Empty area is an explicit no-repository state. | P/T/L/D: Copy wraps and body scrolls if needed. | P/T/L/D: Added conventional recovery link and concise copy. |

### Supporting-dialog audit

| ID | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll and actions | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AUX-01 | P: full usable dialog width within 7px backdrop; T/L/D: capped 620px centered. | P/T/L/D: Evidence links and persistent Close/title close are clear. | P/T/L/D: Pass; shared classic frame, inset facts, blue headings. | P: facts use 115px label column; T/L/D: 150px labels. | P/T/L/D: Remaining fact-pane space supports readability. | P/T/L/D: Body owns scroll; Close remains fixed. | P/T/L/D: Replaced bottom-sheet shadow with centered classic window shadow. |
| AUX-02 | P/T/L/D: Pass; loading/missing/error use the same compact workshop. | P/T/L/D: Retry, disabled reconnect explanation, and Close are explicit. | P/T/L/D: Pass; same classic recovery surface. | P/T/L/D: State copy is content-sized. | P/T/L/D: Blank workshop sections are not rendered during recovery. | P/T/L/D: Actions remain fixed; recovery copy scrolls if needed. | P/T/L/D: Shared workshop frame retained. |
| AUX-03 | P: 376×528; T/L/D: 520×428 centered. | P/T/L/D: Section headings, Close, title close, Escape/F1 behavior. | P/T/L/D: Pass; inset white help page in classic frame. | P/T: touch Close; L/D: compact. | P/T/L/D: Dialog height follows help content. | P/T/L/D: Body is bounded scroll region; action fixed. | P/T/L/D: Verified at all checkpoints; no additional change. |
| AUX-04 | P/T/L/D: Pass; shared confirmation is centered and content-sized. | P/T/L/D: Cancel and explicit confirm action are unambiguous. | P/T/L/D: Pass; shared alert-dialog chrome and raised buttons. | P/T: wrapped touch actions; L/D: compact row. | P/T/L/D: No unused content area. | P/T/L/D: Body scroll and fixed actions follow DialogFrame contract. | P/T/L/D: No additional change. |

## Verification record

- 2026-08-31, administrator recovery: `ROOM-02` now opens the existing `GH-01` sign-in dialog from a denied save, preserving the draft. The built application was exercised with real room-setting, session, and control routes in an isolated temporary room. At P/T/L/D, the recovery button and sign-in/close controls remained reachable; closing restored focus and retained the draft, with no horizontal overflow. Existing classic chrome, compact sign-in proportions, intentional background draft context, and independent body scrolling were retained; Apply/Cancel stayed fixed. Administrator sign-in followed by Apply succeeded, and saves at every checkpoint succeeded, including after a page reload. `src/room-configuration-dialog.test.tsx` covers denied saves, failed sign-in, cancellation, owner bootstrap (`GH-02`), draft preservation, and fresh administrator CSRF on retry; the unchanged bootstrap form layout retains its existing audit evidence.
- 2026-08-31, member roster authorization: `CHAT-03`, `ROOM-05`, and `ROOM-06` were exercised through the built application at P/T/L/D, using an isolated temporary room, the real roster/session/control routes, an unclaimed owner, and synthetic model discovery. At each checkpoint, Room → Manage agents opened without an administrator prompt; an alias edit saved successfully and appeared when the dialog reopened. Phone retained the Your agents back action; T/L/D retained the roster/detail split. The existing classic controls, proportions, empty-space treatment, and independent pane scrolling are unchanged; Save and Cancel remained reachable.
- The same check exercised `ROOM-07` model selection and agent creation, plus member-authorized catalog refresh. P/T/L/D dialog bounds were 362×830, 744×940, 1000×576, and 1416×876; no horizontal page overflow occurred, and footer action bottoms were 828/972/581/884 pixels within the respective viewports. A newly created agent remained present after reopening. The completed browser verification reported no errors or warnings. No live provider calls or existing room data were used.
- `ROOM-04` remains the unchanged administrator fallback for callers without member access; its sign-in interaction remains covered by `src/roster-manager.test.tsx`. Member loading/saving and the real application entry point are covered by that file and `src/reconnect-flow.test.tsx`; `src/roster-api.test.ts` checks separate member and administrator CSRF use. Server membership, denied/recovered access, owner-bootstrap independence, stale revisions, and unchanged privileged boundaries are covered by `server/roster-api.test.ts` and `server/human-session.test.ts`.
- Rendered app-frame measurements: P 378×832 at 6px equal margins; T 744×1000 at 12px; L 1000×576 at 12px; D 1400×876 at 20px horizontal and 12px vertical margins. All four reported zero page overflow.
- Rendered full-workspace measurements after correction: T 724px and L 980px view widths with only the intended 22px outer/application chrome to the right; the former 240px empty track is gone.
- Rendered Room Properties measurements confirmed persistent actions and bounded content scroll on both pages at all checkpoints. Agent Behavior content scrolls independently when its 960px phone content or 856px laptop content exceeds the available region.
- Rendered profile, Help, GitHub administrator sign-in, and Manage Agents administrator sign-in were centered and content-sized at all checkpoints. The Manage Agents sign-in changed from a 1000×576 editor-sized window to a 640×429 content-sized window at L and a 362×465 centered window at P.
- State variants and interaction contracts are covered by the focused component tests, layout-structure contract, UI standards suite, overlay tests, and reconnect-flow suite. The configured GitHub state was additionally adapted from the sibling worktree’s reported desktop/375px visual checks and re-expressed through shared primitives.

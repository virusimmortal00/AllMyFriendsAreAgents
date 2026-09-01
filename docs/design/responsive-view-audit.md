# Responsive view audit

## Taller Manage Room Agents workspace — 2026-08-31 (focused review complete; findings open)

Affected views: `ROOM-05` Manage Room Agents — Roster and `ROOM-06` Manage
Room Agents — Agent Detail. The editor now uses 78% of the dynamic viewport,
capped at 800px and by its padded modal area. This makes it slightly taller than
the underlying chat pane, exposes more agent rows, and keeps the existing
collection/detail scroll ownership. Phone layouts remain full-screen and the
authentication dialog remains content-sized.

The corrected full matrix passed 570 browser tests with six intentional compact-
chat skips, captured all 714 screenshots, and reported zero layout failures.
Source-input digest:
`ad91c606d3bf211897e147b7b3e2e1452306528f66a16c6080884de76e1a9912`.
The broad quality gate passed 1,196 tests with one intentional skip, UI and
integration checks, visual typechecking, and the production build.

Focused rendered checks for the roster and detail views passed 24 tests and
captured 48 top/bottom screenshots across both engines and all six viewport
sizes. Nested model-picker, conflict, and unsaved-confirmation states passed 36
additional focused tests after raising the large-display cap from 720px to
800px. These filtered captures are debugging evidence, not independent visual
approval.

Fresh independent review covered the final 24 `ROOM-05` roster images at all six
viewport sizes in Chromium and WebKit, with 12 completed account-backed review
receipts. Eighteen images pass and six remain flagged. The strengthened exact
validator correlates every receipt with its prompt, attached image hashes,
fresh reviewer session, completion time, and verdict hash without an integrity
error. Overall approval still fails because the six findings remain and the
other 690 matrix images lack independent review for this digest. `ROOM-06` and
`WORK-02` retain geometry-checked current captures; their immediately preceding
independent verdicts are historical evidence, not approval of this digest.

Each question cell counts flagged images; zero means all assigned images passed
that question, not that every possible runtime state was tested.

| View | Images | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll/actions | Outcome | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ROOM-05 Roster | 24 | 2 | 0 | 0 | 0 | 2 | 6 | 6 | Expandable aliases and stable navigation pass; WebKit compact scroll cues remain weak, while Tablet reviewers disagree with the deliberate extra roster capacity. |
| ROOM-06 Agent Detail | 0 | — | — | — | — | — | — | — | Current screenshots pass geometry checks; no independent image verdict is claimed for this digest. |

Original-image inspection retains the roster findings. The taller
window is an explicit workspace-allocation decision: its primary value is showing
more agents, so it is not reduced to fit the currently selected agent's shorter
form. The destructive action remains separated at the bottom of that pane to
avoid presenting deletion as part of ordinary configuration. A future change
could use the additional detail space for useful room-agent diagnostics, but
must not inflate controls or reintroduce nested framing merely to fill it.

## Unified Room Properties tabs — 2026-08-31 (focused review complete; scroll finding open)

Affected views: `ROOM-01` Room Properties — General and `ROOM-02` Room
Properties — Agent Behavior. General now uses the same compact property-section
typography, responsive padding, field rhythm, surface, and control sizing as
Agent Behavior. The selected tab has no bottom border and covers the tab-list
baseline so it reads as one continuous surface; inactive tabs retain the complete
raised outline with a light sheet-colored lower edge rather than a dark
button-like edge. Tab/window/action bounds and all settings behavior remain unchanged.

A focused rendered check passed both engines at Phone, Short phone, Minimum
phone, Tablet, Short laptop, and Desktop: 12 tests and 12 General screenshots.
That test switches to Agent Behavior and compares the two pages' computed
padding, font, and background while checking the selected bottom edge on both
tabs. The filtered capture is debugging evidence, not independent visual
approval.

The corrected full matrix passed 570 browser tests with six intentional compact-
chat skips, captured all 714 screenshots, and reported zero layout failures.
Source-input digest:
`a796c529f65876498c72f33a6e11faba9e3ead923fd9eedaa03e1f23b20799ef`.
UI/integration checks, visual typechecking, and the production build passed.
The broad repository run passed 1,137 tests with one intentional skip; two
unrelated backend tests hit their intermittent temporary-file and server-start
races. Their exact two files passed all 13 tests on immediate focused rerun.

Fresh independent review covered all 36 original General and Agent Behavior
images at six viewport sizes in Chromium and WebKit, with 12 completed
account-backed receipts. General passes all 12 images. Agent Behavior passes 19
of 24, with five WebKit images retaining the prior overlay-scroll-affordance
finding. No image flags
the active or inactive tab edges, typography, padding, surface,
proportion, or empty area. No earlier verdict was reused. The exact validator
confirms current inputs but fails overall approval because five findings remain
and the other 678 matrix images lack independent review for this digest.

| View | Images | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll/actions | Outcome | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ROOM-01 General | 12 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Passes the focused review at every engine/viewport combination. |
| ROOM-02 Agent Behavior | 24 | 0 | 0 | 0 | 0 | 0 | 5 | 5 | Folder-tab styling passes; five WebKit images still lack a sufficiently visible overlay-scroll cue. |

Original-image inspection agrees that the selected tab merges into the page and
that both pages now share one compact visual system. The remaining failures are
preserved, not reclassified; strengthening the shared non-text scroll cue
requires a fresh capture and review.

## Compact Agent Behavior property sheet — 2026-08-31 (focused review complete; findings open)

Affected views: `ROOM-02` Room Properties — Agent Behavior and its embedded
`ROOM-03` Room Summarizer Model Picker. `ROOM-01` General is regression-checked
for stable tab/window/action bounds, not redesigned. The behavior page previously
inherited oversized headings and body text, framed every section, stretched its
reset action, and bypassed the shared checkbox appearance.

The page now uses reusable compact property sections and field-heading action
rows, a classic checkbox and native classic select, thin section separators,
and resizable 80px prompt editors. All settings, explanations, revisions, save
semantics, lazy model loading, and draft preservation are retained. Window size
and footer placement do not change between tabs. Existing review verdicts below
are historical evidence, not approval of this new source.

The corrected full matrix passed 570 browser tests with six intentional compact-
chat skips, captured all 714 screenshots, and reported zero layout failures.
Source-input digest:
`b353953a2cc60bdf37ba04d30f86c4528447894287c014c52db423ee37afb761`.
The full quality gate passed 1,139 tests with one intentional skip, the 67-test
UI standards gate, integration checks, visual typechecking, and production build.
An earlier quality run caught unsupported Testing Library query options in the
new test; those options were removed before the successful gate and final capture.

The fictional preview was also checked by editing and resetting the base prompt,
disabling and re-enabling it, switching tabs, and opening and returning from the
summarizer chooser. No live room data or provider calls were used. Fresh independent
review completed 60 original images covering these three views at all six
viewport sizes in both engines, with 24 completed account-backed review receipts:
51 image verdicts pass and nine remain flagged. No earlier verdict was reused.
The exact validator confirms current inputs but fails approval for those findings
and incomplete whole-matrix review. Original PNGs, seven-question answers,
receipts, results, and validator output are retained together locally.
The other 654 images are captured and geometry-
checked, not independently reviewed for this source digest. Physical-device
behavior, software keyboards, browser chrome, and enlarged text remain outside
this matrix.

Each question cell counts flagged images; zero means all assigned images passed
that question, not that every possible runtime state was tested.

| View | Images | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll/actions | Outcome | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ROOM-01 General | 12 | 1 | 0 | 0 | 0 | 1 | 0 | 1 | WebKit Short phone still has excess space below the short form. This tab was not redesigned. |
| ROOM-02 Agent Behavior | 24 | 0 | 0 | 0 | 0 | 0 | 7 | 7 | Compact styling passes; WebKit overlay-scroll cues remain insufficient at both ends of all three phone sizes and Tablet top. |
| ROOM-03 Summarizer Model Picker | 24 | 1 | 0 | 0 | 1 | 0 | 1 | 1 | WebKit Short phone bottom still exposes card fragments behind the sticky Back region. |

Original-image inspection confirms the weak overlay-scroll cue, General's unused
lower area, and fragments above the picker Back bar. These are retained findings,
not overridden verdicts. The bounded styling change does not resolve the shared
scroll-affordance or embedded-picker composition issues. Follow-up changes should
strengthen the existing non-text scroll cue, reserve a clean picker navigation
boundary, and address General's allocation without reintroducing tab/window jumps.
All require a fresh capture and independent review after implementation.

## Shared control density — 2026-08-31 (focused review complete; broader findings open)

Scope: all registered views that render standard commands or application chrome,
especially Room Chat, Room/Window menus, Manage Room Agents, Room Properties,
and dialog actions. Width-only tablet rules previously changed menu rows from
20px to 40px on mouse-driven windows; a short-height rule changed them again to
32px. Presence commands, default commands, roster actions, and dialog footers
also independently specified 23px, 25px, 30–32px, and 35px heights.

Shared CSS density tokens now select compact fine-pointer or larger coarse-pointer
controls. Viewport breakpoints only reflow the layout. Standard commands share
height, line height, type size, and padding; menu and formatting rows keep their
own documented role sizes. Send shares the formatting command band above a
full-width message field instead of stretching with the textarea. The status strip retains a stable
24px allocation. Existing view identities remain unchanged.

Browser regressions compare chrome and command sizes while crossing the
reported width/height boundaries, navigating into the manager, focusing Cancel,
and comparing enabled/disabled actions. The same measurements run against every
matrix screenshot. The earlier framing work and its original review evidence
below remain retained; they do not approve this newer shared-control revision.

All 24 focused browser tests pass in Chromium/WebKit. The initial density capture
correctly failed the regular Phone detail-form fit check by 28px/22px. Model
identity now shares a row with its change action; the narrow destructive section
places its action beside the heading and gives the explanation a full-width row.
This preserves the touch targets and all information while restoring full-form
fit. The full-width explanation regression remains, updated for that composition.
The failed capture is retained; neither it nor the focused run provides visual
approval. The corrected full matrix passed 570 tests with six intentional
compact-chat skips, captured all 714 screenshots, and reported zero layout
failures. Source-input digest:
`f85ae7eda1ddf912c6b11cecbb2c6a06120eb3ced6e93d0ec5870aed65102ba4`.
The quality gate passed 1,139 tests with one intentional skip, UI/integration
checks, visual typechecking, and the production build. Earlier intermittent
backend results below remain recorded; a passing run does not establish their
cause or resolution.

The restored fictional preview was checked by opening the manager, reaching
Iota, editing its alias, discarding the draft, and reopening to verify the
original alias. Room Properties also completed an Agent behavior/General round
trip and returned to Chat. No live room data or provider calls were used.
The intermediate independent review selected 150 original images: Room Chat, Compact
Room Chat, Room and Window menus, Roster, Agent Detail, Room Properties General
and Agent behavior, roster conflict, and configured GitHub repository, at every
applicable matrix size in both engines. It was stopped after 38 image verdicts
(34 pass, four flagged) and 14 receipts to correct the newly identified Send
side-column gap before consuming more review usage on obsolete input. Original
verdicts and receipts remain unchanged. The exact validator reports stale inputs,
partial coverage, and the flagged questions; this capture is not approved.

Two flags concern excessive empty space in General Room Properties at regular
and Short phone sizes. Those remain open; resizing one tab independently would
reintroduce the window jump rejected by the shared property-sheet contract.
One Short phone agent-detail flag requests Delete below its explanation; the
implemented composition instead keeps the action beside the heading with the
entire explanation on its own full-width row. Original-image inspection finds
neither squeezed copy nor an obscured action. This is retained as an ordering
disagreement, not cleared as a passing verdict.
The fourth flag exposed the compact-chat Send side-column gap. Send now shares
the command band and the textarea spans the full width. New rendered checks
require that arrangement and aligned command bottoms. All 42 focused browser
tests passed, with six intentional compact-chat skips; full capture and fresh
independent review of the corrected source are pending.

The corrected command-band revision passed the full matrix again: 570 tests,
six intentional skips, 714 screenshots, and zero layout failures. Current
source-input digest:
`559febd4eb6fa83ca5f8ec26b9a016d8397610c7beb0e97a28f73b1ea840f8f2`.
Its quality gate passed 1,139 tests with one intentional skip, UI/integration
checks, visual typechecking, and the production build. Fresh independent review
completed the same 150-image scope with 54 receipts: 122 passing image verdicts
and 28 flagged verdicts. No earlier verdict was reused. The exact validator
confirms current inputs but fails approval for flagged questions and incomplete
whole-matrix review. The remaining 564 screenshots are captured and geometry-
checked, not independently reviewed for this digest. Original PNGs, per-image
answers, receipts, result, and validator output are retained together locally.

Each cell counts flagged images for that question. Zero means all assigned
images passed that question, not that every possible runtime state was tested.

| View | Images | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll/actions | Outcome | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CHAT-01 Room Chat | 12 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Current focused pass; full-width composer and shared controls. |
| CHAT-02 Compact Room Chat | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Current focused pass at the three narrow checkpoints. |
| CHAT-03 Room Menu | 12 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Current focused pass; stable menu density. |
| CHAT-04 Window Menu | 12 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Current focused pass; stable menu density. |
| ROOM-01 General | 12 | 9 | 0 | 0 | 8 | 9 | 0 | 9 | Excess unused body space remains open. |
| ROOM-02 Agent Behavior | 24 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | Minimum-phone WebKit scroll cue remains open. |
| ROOM-05 Roster | 24 | 0 | 0 | 0 | 0 | 0 | 6 | 6 | Coarse-pointer scroll discoverability remains open. |
| ROOM-06 Agent Detail | 24 | 0 | 0 | 0 | 1 | 0 | 3 | 4 | Scroll cues open; ordering and capture-owner disagreements retained. |
| ROOM-08 Conflict | 12 | 1 | 0 | 0 | 1 | 0 | 5 | 5 | Scroll cues and minimum-phone content allocation remain open. |
| GH-06 Configured Repository | 12 | 2 | 0 | 0 | 0 | 2 | 0 | 2 | Both minimum-phone flags identify the background composer, not GitHub content. |

Original-image adjudication does not modify the reviewer verdicts:

- In both minimum-phone GitHub images, the white region is below the dialog's
  bottom border/shadow and belongs to the inactive chat composer. Removing it
  from GitHub settings would target the wrong surface; the flags remain disputed.
- The Chromium Short laptop conflict image has a visible native track/thumb on
  the roster. A discoverability/contrast concern can remain, but absence of a
  scrollbar is not reproduced. Coarse-pointer images do show weaker cues.
- The WebKit Tablet Agent Detail bottom image describes the detail pane's scroll
  owner, not the separate roster. Its companion Roster bottom capture and the
  last-agent navigation test cover the roster's lower boundary. The requested
  recapture confuses those owners; the verdict remains retained, not cleared.
- The Short phone Delete explanation occupies its own full-width row below the
  heading/action. The reviewer prefers action-after-explanation ordering; no
  text clipping or squeezed side-column explanation is observed.

Next bounded work is shared scroll-edge detection on touch/overlay platforms,
a compact common Room Properties height that still stays stable across tabs,
and minimum-phone conflict composition. Do not restore instruction rows, shrink
standard touch buttons, or independently resize property tabs to hide these
findings. The remaining 37 views have no fresh independent review in this scope;
earlier open findings, including the Room Summarizer Model Picker, remain open.
Physical-device browser chrome, software keyboards, and text enlargement remain
outside the emulated acceptance matrix. No live room state, deployment, or
production checkout was changed.

## Simplified agent-manager framing — 2026-08-31 (verification in progress)

Affected views: `ROOM-04`–`ROOM-09`; the reported border stacking is in
`ROOM-05` Manage Room Agents — Roster and `ROOM-06` Manage Room Agents — Agent
Detail. The generic introductory paragraph is removed. The body, master/detail
wrappers, and identity header no longer add frames; their spacing establishes
the layout. A single inset edge belongs to the white roster collection, not its
surrounding header and action. Inputs and buttons retain classic inset/raised
edges; meaningful named groups remain distinct, and the destructive section
uses a simple hairline rather than another groove.

The content-led window height, aligned pane bottoms, native scrolling, persistent
actions, keyboard behavior, and narrow-layout touch targets are preserved.
Regression checks reject reintroduced wrapper borders and a missing collection
inset; the component test rejects the removed introduction. The 27 focused
component/layout tests passed. The first capture was stopped after WebKit Phone
and Short phone failed full containment of the final section: removing all pane
padding exposed fractional scroll-boundary clipping. A one-pixel bottom clearance
passed those two cases but left a fractional side-boundary failure on Short
laptop WebKit. That full run retained 713 screenshots and 557 passing scenarios,
with one failed scenario and six intentional skips; it is not approved.
The final pane uses four pixels of borderless paint/focus clearance on all sides.
All 12 focused detail scenarios now pass across both engines and six sizes,
including unchanged full-section visibility and a new focused-checkbox clearance
check. Their 24 original screenshots are retained. The stopped capture and
zero-capture setup attempts are not valid review evidence. Final rendered capture
and independent review are in progress.
Earlier source digests and open findings below remain historical evidence, not
approval of this revision.

The next full capture passed 558 scenarios with six intentional compact-chat
skips, all 714 screenshots, and zero layout failures. Source-input digest:
`668fa9e02f7d6a18b918dd2dc197343a919e06a2ca2fa93ac4a46adc5c125ead`.
The quality gate passed 1,139 tests with one intentional skip, UI/integration
contracts, visual-test typechecking, and the production build. The restored
fictional preview renders the simplified manager without a framework error
overlay; opening the manager, reaching the last agent, and returning to Chat
work. Editing and discarding an alias restores its original value. The checks
use fictional API responses and do not mutate live room state or call providers.
Independent review completed all 108 affected images with 36 receipts: 96 passing
and 12 flagged image verdicts. Its findings identify
cramped destructive copy on regular/short phone detail panes, not redundant
wrapper borders. The stacked Delete layout now applies through a 360-pixel pane
width, with the existing full-width explanation regression extended accordingly.
All 12 detail scenarios pass after this adjustment. The original review is
retained unchanged and becomes stale for the corrected source; fresh capture
and review of changed images are required before claiming verification.

Each cell below counts flagged images for that question; zero means every
assigned image passed that question in this historical review, not the newer
shared-density source.

| View | Images | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll/actions | Outcome | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ROOM-04 Sign in | 12 | 1 | 0 | 0 | 1 | 1 | 0 | 1 | Tablet empty-area claim disputed after original-image inspection; retained. |
| ROOM-05 Roster | 24 | 0 | 0 | 0 | 0 | 0 | 3 | 3 | Coarse WebKit scroll cues remain open. |
| ROOM-06 Agent detail | 24 | 3 | 0 | 0 | 4 | 0 | 2 | 6 | Narrow destructive composition corrected; scroll-cue claims remain open. |
| ROOM-07 Model picker | 24 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Historical pass; current source requires new review. |
| ROOM-08 Conflict | 12 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | Coarse WebKit scroll cue remains open. |
| ROOM-09 Discard confirmation | 12 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | Background isolation claim retained; active confirmation content is not clipped. |

The sign-in image has approximately 20px between the form and its standard
footer, not the large unused section described by that verdict. The confirmation
overlays an inactive background heading; it does not clip the confirmation's
own contents. These interpretations are explicitly disputed, not silently
rewritten as passing reviews.

The corrected full capture passed 558 scenarios with six intentional skips,
714 screenshots, and zero layout failures. Historical corrected source-input digest:
`ff52462cd5330a7b6b2e26546c90ba3ce11adef50dccf284f82ae0be4566a113`.
The final quality gate is **not clean**: UI/integration contracts, typechecking,
and build passed, but one full-suite run failed the consultation cancellation
race test with `STALE_REVISION`. A full rerun instead failed two storage/restart
tests with temporary-file `ENOENT` errors. The three consultation end-to-end
tests and the 21 consultation/investigation service tests passed their focused
reruns. Those backend files are unchanged; these intermittent results remain
unresolved and are not concealed by earlier passing runs. No backend changes
were made as part of this visual correction.

## Content-led agent property sheet — 2026-08-31 (focused verification; app-wide approval pending)

Affected views: `ROOM-04`–`ROOM-09`, with the reported empty-canvas defect in
`ROOM-05` Manage Room Agents — Roster and `ROOM-06` Manage Room Agents — Agent
Detail. The previous fixed-height outer window outlived the form's reduction in
height, exposing a contrasting near-white canvas below it. The earlier tablet
tradeoff is superseded: avoiding that wasted area takes precedence over showing
every roster entry simultaneously. Original flags and evidence below remain
retained; they are not rewritten as passes.

The two-column manager now has intrinsic height bounded by the viewport. Its
roster is size-contained, so the detail form determines the working height and
both panes end together. Longer lists retain native scrolling; their item count
cannot expand the window or leave blank canvas beneath the form. The property
sheet background matches the gray form surface. Single-pane phone layouts still
use the available viewport. No controls, explanations, touch targets, or
keyboard behavior are removed, and no JavaScript height synchronization is used.

This deliberately changes the earlier tablet-specific nine-visible-row check.
Its replacement checks matching pane bottoms, no unused area below a fitting
form, a consistent background, and last-agent reachability. Existing controls,
row overlap, primary-name wrapping, scroll affordance, default-form fit, and
draft-discard checks remain. All 24 focused roster scenarios passed across the
six sizes and both engines. The full capture passed 558 scenarios with six
intentional compact-chat skips, all 714 screenshots, and zero layout failures.
Source-input digest:
`c77926a22e50864bc7387f5daeaebb1dd9ed92f7636f18641e50c9efd6b19700`.
The quality gate passed 1,139 tests with one intentional skip, UI/integration
contracts, visual-test typechecking, and the production build.

The restored fictional preview rendered without a framework error overlay.
Opening Manage Agents, selecting the last roster entry, editing its alias,
discarding the draft, and reopening confirmed the original value and reachable
navigation. No live room state or provider calls were used.

Independent review of that intermediate capture completed all 108
`ROOM-04`–`ROOM-09` images with 36 session receipts: 100 passing image verdicts
and eight flagged images. Every image passed the empty-area question. The
seven-question results below describe that snapshot, not approval of later source.

| ID | View | Reviewed | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll/actions | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ROOM-04 | Manage Room Agents — Sign In | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| ROOM-05 | Manage Room Agents — Roster | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 22/24 | 22/24 |
| ROOM-06 | Manage Room Agents — Agent Detail | 24/24 | 23/24 | 24/24 | 24/24 | 23/24 | 24/24 | 21/24 | 20/24 |
| ROOM-07 | Manage Room Agents — Model Picker | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 |
| ROOM-08 | Manage Room Agents — Conflict | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 10/12 | 10/12 |
| ROOM-09 | Unsaved Changes Confirmation | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |

Disposition of the eight original flags:

- Minimum-phone Chromium detail bottom: the Delete action squeezed its
  explanation. Detail panes at most 300 pixels wide now stack that action below
  full-width copy; browser regressions check both the order and usable line width.
- Chromium Tablet detail bottom: **disputed capture-scope interpretation**. The
  detail pane fits without scrolling, so its top and bottom captures are equal.
  The separate roster-bottom capture shows the final agent at scroll offset
  194/194. WebKit's corresponding roster evidence reaches 196/196. No verdict is
  rewritten; these separate captures establish reachability, not visible scroll
  discoverability in every image.
- Six WebKit images remain **open** for weak visible scroll cues: Minimum-phone
  roster top/bottom, Phone conflict top, Tablet detail top/bottom, and Tablet
  conflict top. A reserved native gutter does not prove that a track or thumb is
  visible. The next bounded correction should verify an unobtrusive directional
  cue on touch layouts without restoring instruction rows. The Tablet detail
  bottom finding also contains the capture-scope ambiguity described above.

After the narrow Delete-row correction, the final full capture again passed
558 scenarios with six intentional skips, 714 screenshots, and zero layout
failures. The quality gate passed 1,139 tests with one intentional skip,
UI/integration contracts, visual-test typechecking, and the production build.
Final source-input digest:
`853276a68894ce16c421dda2f6249e73e25c1f3d51a95e0cf8c8b888ab342aac`.
The earlier 108-image review is retained unchanged and is stale for this source
digest. Fresh review covers the changed screenshot hashes and their paired
top/bottom positions; it does not inherit earlier verdicts as current approval.

The fresh review completed seven images with three session receipts; all seven
passed every question. It covers Minimum-phone detail top/bottom in both engines,
Minimum-phone Chromium conflict, and WebKit Tablet summarizer-picker top/bottom
(the latter was included because its rendered hash changed). The corrected
Delete-row finding is resolved in this evidence. A later passing summarizer
verdict does not silently clear the earlier recorded sticky-Back overlap finding.

| ID | View | Reviewed | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll/actions | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ROOM-03 | Room Summarizer Model Picker | 2/24 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| ROOM-06 | Manage Room Agents — Agent Detail | 4/24 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| ROOM-08 | Manage Room Agents — Conflict | 1/12 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |

The exact-capture `check:visual-review` gate remains **failed**, with:
“Every expected screenshot needs exactly one independent review.” Only seven
of 714 images have current-digest independent verdicts; the other 707 are not
approved by this focused pass. All other registered views and unselected
engine/viewport/state combinations remain independently unverified for this
digest. The six open scroll-cue flags above and prior summarizer overlap remain
recorded separately. Real-device browser chrome, physical touch behavior, and
software-keyboard interaction were not tested; verification used the six
emulated checkpoints, not a physical phone. The audit parity test (five tests)
and `git diff --check` passed. The local fictional preview uses this final build;
no production deployment or live-room update was performed.

## Scroll affordances and compact agent properties — 2026-08-31 (focused review complete; app-wide approval pending)

Primary reported views: `ROOM-05` Manage Room Agents — Roster and `ROOM-06`
Manage Room Agents — Agent Detail. The shared change also affects native panes
throughout Chat, Room Properties, model pickers, workspaces, and utility dialogs;
all registered views remain subject to the full capture matrix.

Removed the dedicated scroll-instruction and “all shown” rows. Native browser
tracks/thumbs retain native behavior with neutral gray colors and stable gutters where supported.
Fine-pointer layouts expose a classic native track/thumb; touch layouts retain
platform sizing. Inline-size queries live inside the roster scroll owner so
WebKit accounts for the native gutter when laying out its content.
Overlay-only platforms instead expose a small inset shadow at only the
edges with more content. The shared observer decorates actual scroll owners,
not a footer summarizing unrelated panes; no extra DOM row or custom scrolling
control is rendered. Persistent actions retain their existing placement.

Earlier Chromium captures inadvertently used the headless `--hide-scrollbars`
default; they cannot establish native-scrollbar discoverability. That flag is now
excluded, with a regression test for the launch configuration. Subsequent checks cover
direction-aware edge state, native gutter geometry, both scroll ends, fitting
content, hidden/late-mounted panes, and observer cleanup. The intermediate full capture
passed 558 scenarios with six intentional compact-chat skips: all 714 images,
all 47 registered views, and zero layout failures. The 36 formatting-popup
resize checks also passed across the two engines and six viewport checkpoints.
The quality gate passed 1,138 tests with one intentional skip, UI contracts,
visual-test typechecking, and the production build. Source-input digest:
`9858bd3ab6b31c6684891cad71d61f6410697a47600fee38fea893a72064e283`.

The intermediate source snapshot above is not approved. Independent review
flagged `chromium--phone-minimum--roster-detail--top`: the content mask crossed
the Change model action and redundant nested framing crowded the narrow pane.
Two Short laptop roster images also flagged missing visible scroll affordances.
The review was interrupted after retaining 26 completed image verdicts (23 pass,
three flagged) and their receipts. These failures remain recorded; they are not
overridden by the subsequent capture-configuration correction.
The correction removes the mask in favor of inset shading painted below content
and removes the unlabelled frame around the detail form. A browser regression
now requires the initial Change model action to fit inside the detail viewport.
The detail form also now uses a single editable identity header, one complete
model summary including maker/access provider, inline property rows, and a
responsive command grid. All explanatory copy and controls remain available;
touch targets are retained. The default form must fit regular Phone, Tablet,
Short laptop, and Desktop checkpoints. Short phone, Minimum phone, expanded
pickers, and additional runtime diagnostics can still scroll.

The corrected full capture passed 558 scenarios with six intentional skips,
all 714 images, and zero layout failures. The default-form no-scroll check passed
in both engines at Phone, Tablet, Short laptop, and Desktop sizes; the shorter
phone checkpoints retained native scrolling and reachable actions. The quality
gate passed 1,139 tests with one intentional skip, UI contracts, visual-test
typechecking, and the production build. Intermediate source-input digest:
`e9670b8681c24cd1f387001dfc50ba64bb41397d21197dbc07d50779c435ae09`.

That compact-form snapshot received 48 independent image verdicts: 33 pass and
15 flagged. The findings covered four visible issues: ambiguous tiny GitHub
permission status, stretched empty detail panes, undiscoverable pointer-list
overflow, and a partially visible final tablet roster row. Original verdicts,
receipts, and the failed gate are retained, including the stale-source result
after corrections began; this snapshot is not approved.

Corrections keep the GitHub checkbox/label together with an explicitly named,
readable status line linked through `aria-describedby`; size fitting detail panes
to their content; expose native pointer scrollbars without instruction rows;
and reduce redundant roster-header spacing so the tablet's final row fits.

The next full capture passed 558 scenarios with six intentional skips, retained all
714 screenshots, and reported zero layout failures. Source-input digest:
`697ce22c4208f7eb4a604e537d2305c134892dc7c8910440f118da4faa98d6de`.
The complete default agent form fits Phone, Tablet, Short laptop, and Desktop
in both engines; the two shorter phone checkpoints retain native scrolling.
All controls and explanatory copy remain available. The quality gate passed
1,139 tests with one intentional skip, integration/UI contracts, visual-test
typechecking, and the production build.

The native-pointer scrollbar correction also exposed horizontal overflow in
the color palettes when resized to the supplemental 320×200 viewport. The
shared popover now uses a vertical flex frame so its body reflows within the
scrollbar gutter. All 36 color/smiley resize checks passed without hiding
horizontal overflow or relaxing the containment requirement. This also affects
`CHAT-06` Text Color Palette, `CHAT-07` Highlight Color Palette, and `CHAT-08`
Classic Smiley Picker.

Independent review of those 84 images produced 78 passing image verdicts and six
flags. Four Chromium Desktop roster/detail images flagged the oversized empty
canvas beneath the compact form. The correction bounds the large-screen window
to 1120×640 while keeping smaller layouts viewport-bounded; the full default
form still fits. A new browser regression rejects excessive unused canvas below
the desktop default form. All 24 focused roster checks passed after the change.

Seven-question results for that intermediate snapshot (passing judgments over
images reviewed, not approval of later source):

| ID | View | Reviewed | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll/actions | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ROOM-05 | Manage Room Agents — Roster | 24/24 | 22/24 | 24/24 | 24/24 | 24/24 | 22/24 | 24/24 | 22/24 |
| ROOM-06 | Manage Room Agents — Agent Detail | 24/24 | 20/24 | 24/24 | 24/24 | 24/24 | 20/24 | 24/24 | 20/24 |
| CHAT-06 | Text Color Palette | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-07 | Highlight Color Palette | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-08 | Classic Smiley Picker | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |

Two WebKit Tablet detail images also flagged unused space below the form. This
finding remains **open/disputed**, not approved: the taller master column keeps
all nine configured agents visible, while shrinking the window introduces list
scrolling. Stretching the detail card would recreate the earlier empty-panel
problem. The tablet layout is unchanged pending a deliberate master/detail
tradeoff; a later passing verdict on unchanged pixels must not silently clear
these original flags. The original verdicts, receipts, and failed/stale gate are
retained.

The final bounded-window capture passed 558 scenarios with six intentional skips,
all 714 screenshots, and zero layout failures. Its source-input digest is
`9ec860a0079b1c4815a1e876fe7644624a4299dfa37b93fb5679fcb1fbede4a3`.
The quality gate again passed 1,139 tests with one intentional skip, UI/integration
contracts, visual-test typechecking, and the production build. The audit parity
test and `git diff --check` also passed.

Screenshot-hash comparison found 18 changed images. Those images and their
paired scroll positions received 20 fresh independent judgments in eight Codex
sessions: 19 pass, one flagged. This covers both engines' Desktop roster,
detail, model picker, conflict, and unsaved-confirmation states, plus WebKit
Phone roster and Short phone summarizer-picker pairs. All resized agent-manager
states passed all seven questions. The tablet images are unchanged; their
earlier disputed flags remain open.

| ID | View | Reviewed | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll/actions | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ROOM-03 | Room Summarizer Model Picker | 2/2 | 1/2 | 1/2 | 2/2 | 1/2 | 2/2 | 1/2 | 1/2 |
| ROOM-05 | Manage Room Agents — Roster | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| ROOM-06 | Manage Room Agents — Agent Detail | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| ROOM-07 | Manage Room Agents — Model Picker | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| ROOM-08 | Manage Room Agents — Conflict | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| ROOM-09 | Unsaved Changes Confirmation | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |

The remaining fresh flag is
`webkit--phone-short--room-summarizer-model-picker--bottom`: the same known
sticky Back/result-card overlap previously observed on Tablet also occurs at
Short phone. Its correction remains a reserved, non-overlapping navigation row.
The exact `check:visual-review` gate was run and correctly failed: five failed
judgments on this image and 694 screenshots without a current independent
verdict. Historical verdicts are not copied into the new source snapshot, even
when image hashes match. This is focused evidence, not app-wide approval.

The fictional preview was also checked by opening Manage Agents, editing an alias,
discarding the draft, and reopening to confirm the original value. No live room
state was used or changed.

Prior verdicts below
remain historical; the open summarizer-picker overlap is not implicitly
cleared by this change. Browser captures wait for native scrolling and resize
notifications to settle; persistent failures still retain their screenshot and
fail the same geometry checks. Failed/interrupted iterations are retained, not
treated as approvals. Native mobile keyboard/chrome and forced-colors behavior
remain outside the verified matrix.

## Room Properties tab-transition correction — 2026-08-31

Affected identities: `ROOM-01`, `ROOM-02`, and the embedded `ROOM-03` picker.
Earlier per-page screenshot approvals missed a stateful rendering defect: after
Agent behavior loaded, returning to General left the hidden behavior panel in
the CSS grid and collapsed General to zero height. A separate page-dependent
width rule also changed the same dialog from 600px to 900px on desktop.

The shared hidden-element rule now prevents inactive pages from painting or
occupying space. `DialogFrame` owns stable property-sheet dimensions; both pages
retain their drafts, share action placement, and scroll within that frame.
Browser regressions compare exact window/action bounds through the tab round
trip and capture General after Agent behavior has loaded. Every app capture
also rejects hidden elements that still occupy layout space.

The new round-trip check passed at all six viewport checkpoints in Chromium and
WebKit (12 cases). The full capture passed 558 scenarios with six intentional
compact-chat skips and retained all 714 images with zero layout failures. The
quality gate passed 1,135 tests with one intentional skip, UI contracts, visual
test typechecking, and the production build. Source-input digest:
`d4b89ab68b9548dc468f69c22f3c0e617ed29c1c5886ff9598c49bb085754849`.

Fresh account-backed review inspected all 60 `ROOM-01`–`ROOM-03` images in 24
sessions: 59 passed and one remains flagged. Counts below are passing judgments
over captured images; all seven answers and original receipts are retained.

| ID | View | Reviewed | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll/actions | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ROOM-01 | Room Properties — General | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| ROOM-02 | Room Properties — Agent Behavior | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 |
| ROOM-03 | Room Summarizer Model Picker | 24/24 | 23/24 | 24/24 | 24/24 | 23/24 | 24/24 | 23/24 | 23/24 |

Open finding: `webkit--tablet--room-summarizer-model-picker--bottom`. At
768×1024, the sticky Back control overlays part of a model card as the settings
page scrolls. The screenshot confirms this composition problem even though its
controls remain reachable. Next bounded correction: give picker navigation a
reserved, non-scrolling row instead of layering it over result content, then
recapture and independently review the affected states. Do not override the
failed verdict or conflate it with the corrected tab-visibility defect.

The strict visual gate remains **not approved**: four failed judgments on that
image plus 654 images without a current independent review. The earlier two
flagged cases are not silently cleared by this focused review. Seven changed
images outside `ROOM-01`–`ROOM-03` (roster/confirmation states) likewise have no
fresh independent review. Prior source snapshots and their failed judgments
below are historical, not approval of this correction. Native mobile
keyboard/chrome behavior remains outside the agreed viewport matrix.

> Evidence correction: the original completion labels overstated rendered
> coverage. All inventory rows are now `Unverified`. The seven-question tables
> below retain historical design judgments, **not current visual approvals**.
> The original record explicitly measured Manage Agents sign-in but did not
> substantiate the populated roster, whose rows could compress and overlap.
> Current evidence requires the capture manifest and independent per-image
> verdicts in `docs/testing/visual-review.md`. Fixtures now enumerate all 47
> registered views; the historical tables alone do not establish approval.

This file is the canonical review ledger for the application-wide responsive UI review. The matching typed identity catalog lives in `src/view-registry.ts`; the validator requires both sources to contain the same IDs, names, states, and order. Together they name every distinct user-facing screen, workspace, dialog, and interactive overlay that requires its own layout judgment. A row is complete only after the view has been checked at every representative viewport and the final questions below have explicit answers.

## Maintenance contract

Treat the IDs and names in `src/view-registry.ts` and this ledger as stable product vocabulary. Use them in issues, pull requests, tests, screenshots, and review notes so a phrase such as “ROOM-02 at Short laptop” identifies one reproducible layout without relying on private context. Rendered view roots expose the same identity through `data-view-id`, `data-view-name`, and `data-view-state`, which makes browser evidence and automated checks traceable back to this ledger.

Before implementing a new user-facing view or materially distinct state:

1. Decide whether it is a new view, a state of an existing view, or a reusable overlay. A new navigation destination, layout hierarchy, primary task, or scroll owner requires a new ID. Loading, empty, failure, and success presentations that retain the same hierarchy normally remain named states of one ID.
2. Add the proposed ID, name, state, and category to `src/view-registry.ts`, then add the identical ID, name, and state to this inventory with status `Pending`. Attach the registry entry to the rendered root through a shared primitive or `viewAttributes`. IDs are never reused or renumbered, even if a view is later removed; record removed IDs in a short retirement note instead.
3. Follow the existing naming grammar: concise title case for the user-facing object or task, an em dash for a property page or integration state, and a distinct-state description that says what changes without restating the name.
4. Build with the shared app-frame, workspace, dialog, tabs, group-box, summary, status, and action-strip primitives. Add a primitive when behavior is cross-cutting instead of copying feature-local window CSS.
5. Check Phone, Tablet, Short laptop, and Desktop and answer all seven questions. Record viewport-specific differences explicitly with `P`, `T`, `L`, and `D` prefixes.
6. Keep the inventory `Pending` or `Unverified`; do not replace evidence with a handwritten completion label. A current manifest, independent image verdicts, and passing `pnpm check:visual-review` establish review for the captured states only.

`src/responsive-view-audit.test.ts` enforces registry/ledger parity, production-code attachment, unique stable IDs, complete inventory/audit pairing, the seven-question schema, and explicit P/T/L/D coverage. It intentionally cannot decide whether an unregistered design is “new”; that judgment remains a required author and reviewer check.

## Representative viewports

| Name | Size | Purpose |
| --- | --- | --- |
| Phone | 390 × 844 | Narrow touch layout and viewport containment |
| Short phone | 390 × 660 | Narrow touch layout with less available vertical space |
| Minimum phone | 320 × 568 | Supported minimum width and constrained vertical space |
| Tablet | 768 × 1024 | Intermediate layout, touch targets, and line length |
| Short laptop | 1024 × 600 | Limited vertical space with desktop navigation |
| Desktop | 1440 × 900 | Large-screen density, hierarchy, and maximum line length |

These are representative checkpoints, not device-specific designs. Layouts must also behave continuously between them and down to the supported 320-pixel minimum width.

The automated matrix checks all six sizes in Chromium and WebKit. These emulated
viewport checks are the acceptance scope;
physical iPhone verification is optional, not a completion gate. Native browser
chrome, software keyboards, and text enlargement remain outside that scope.

## Questions answered for every view

1. Does it make effective use of the available screen without feeling crowded or sparse?
2. Is the primary navigation and the way out obvious and easy to operate?
3. Does it preserve the application’s Windows 95/AIM visual language?
4. Are controls, type, panels, and whitespace proportionate to the viewport?
5. Is any empty area intentional and compositionally useful?
6. Is scrolling owned by the correct region, with important actions remaining reachable?
7. What changed, or why is no change needed?

## Inventory and completion status

### App-wide screenshot remediation — 2026-08-30

The expanded fixture matrix now renders all 47 named views using production
components and fictional API responses. All 46 non-compact views run in Chromium
and WebKit at all six sizes; Compact Room Chat runs at the three phone sizes.
Long forms and lists include lower-scroll captures: 558 applicable scenarios,
six intentional non-phone compact-chat skips, and 714 original screenshots.

The full baseline capture passed all browser assertions. Its quality gate passed
with 1,125 tests and one skipped. Baseline source-input digest:
`5195527f813b47b847a0035103acbc32d91532b60f596bad5843eece7e9f6edd`.
Fresh Codex sessions reviewed every original: 658 images passed all seven
questions and 56 images were flagged; no review sessions failed. The exact
validator correctly failed. Repeated findings were grouped into shared fixes;
normal partial rows at an indicated scroll boundary were recorded as disputed,
not silently approved. Working changes after this digest require new capture
and review. Retain the manifest, PNGs, review records, and invocation receipts
together when reproducing or attaching public evidence.

Corrections prompted by the expanded screenshot review:

- `CHAT-01`–`CHAT-02`, `CHAT-09`: wrapping formatting controls, intrinsic composer
  height, wrapped primary presence names, and visible native-scroll direction.
- `CHAT-05`–`CHAT-08`: shared visible popover exits; mention names wrap and the
  suggestion list remains above the formatting toolbar.
- `CHAT-10`–`CHAT-11`: readable pending-message preview and client-only dismissal
  of a server error notice, without changing authoritative server state.
- `WORK-01`–`WORK-11`: shared scroll cues and a tested route back to Chat; bounded
  recovery panels, inset growing list canvases, full-width diagnostic results,
  readable task headings with stacked narrow-screen edit actions, labeled
  improvement-status fields instead of raw objects, and bounded operational cards.
- `ROOM-01`–`ROOM-03`, `ROOM-07`: multiline topic, scroll cues above property-page
  actions, proportionate prompt editors, an immediately visible opened model
  picker, native compact filter dropdowns, and shared square/inset model-selection
  styling. The embedded summarizer picker uses the settings page's scroll owner
  and a persistent back action that restores focus to its opening control.
- All remaining dialogs inherit the shared overflow cue when needed. Roster
  and property pages retain their own pane-specific cues and fixed actions.

The full review prompted a further correction batch: intrinsic model-card
columns and single-pane scrolling, non-overlapping task status badges, explicit
scroll-direction words, truthful rendered-result counts, classic clickable row
titles, pane-width status-group columns, focused missing-record recovery, and
a growing diagnostics result/detail area. The corrected full-matrix results
are recorded below; the baseline verdicts do not approve changed source.

This matrix covers representative rendered states, not every loading, failure,
permission, or interaction variant. Live authentication, browser chrome,
software keyboards, enlarged text, and landscape remain outside its scope.
Physical iPhone testing is not required for this viewport-based acceptance.

### Latest flagged-case follow-up — 2026-08-31 (partial review; gate not approved)

Shared palettes and smiley pickers now have a viewport-bounded native scroll body,
persistent Close action, conditional scroll cue, and placement outside the entire
formatting toolbar. Native repository selectors use shared square styling and touch
sizing; checkbox focus remains visible on gray and blue. Review batches keep a
view's paired scroll positions together without changing the seven-question gate.

The final capture passed 558 applicable scenarios, with six intentional skips,
714 images, and zero layout failures across all six sizes in Chromium and WebKit.
Source-input digest:
`64a1caf7ae5071c8ffd092dbc3fe9d43416bc606c3b4944f34a01756d7bd4a2b`.
The full quality gate passed 1,134 tests with one skipped. Earlier test failures
and their disposition remain in the historical record below.

Fresh independent review covered 61 selected images: **59 passed and two were
flagged**, with 26 completed sessions and no session failures. This includes every
changed image relative to the preceding snapshot, all 36 popup images, every
repository-selector size, and the eight earlier flagged cases with paired context.
All 36 popup images passed. Seven of the eight flags from the previous complete
review passed; the Short phone Diagnostics boundary observation recurred.

The two current flags are Chromium Short phone Owner Diagnostics Results (bottom)
and GitHub Choose Project Repository. Direct inspection disputes the former's
native-scroll-boundary interpretation and the latter's treatment of a centered
modal as a workspace replacement. Both PNGs are byte-identical to images that
passed in the preceding review. Preserve the conflicting judgments; do not choose
the favorable verdict. Two historical Tablet Background Investigations density
flags also remain open and were not repeatedly submitted for a different judgment.
No speculative padding, filler content, or full-window modal expansion was applied.

The exact gate **failed** for 653 images without current reviews and six failed
question judgments across the two current flags. It reported no stale-source,
screenshot-hash, or layout failures. This is not app-wide visual approval.
Original PNGs, manifest, scope, verdicts, receipts, gate result, and implementation
triage remain together in the ignored capture directory. Nothing was deployed.

#### Current seven-question coverage by named view

Fresh images is reviewed/captured. Question cells are passing current judgments /
captured images; a dash means no fresh judgment, not approval or a new defect.
Per-image observations remain in the original review record. Historical coverage
below is not silently promoted to current approval.

| View | Name | Fresh images | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll/actions | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| APP-01 | Startup | 0/12 | — | — | — | — | — | — | — |
| APP-02 | Join Room | 0/12 | — | — | — | — | — | — | — |
| APP-03 | Join Recovery | 0/12 | — | — | — | — | — | — | — |
| CHAT-01 | Room Chat | 0/12 | — | — | — | — | — | — | — |
| CHAT-02 | Compact Room Chat | 0/6 | — | — | — | — | — | — | — |
| CHAT-03 | Room Menu | 0/12 | — | — | — | — | — | — | — |
| CHAT-04 | Window Menu | 0/12 | — | — | — | — | — | — | — |
| CHAT-05 | Mention Suggestions | 0/12 | — | — | — | — | — | — | — |
| CHAT-06 | Text Color Palette | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-07 | Highlight Color Palette | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-08 | Classic Smiley Picker | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-09 | Poll Cards | 0/12 | — | — | — | — | — | — | — |
| CHAT-10 | Pending Send Recovery | 0/12 | — | — | — | — | — | — | — |
| CHAT-11 | Connection and Action Notices | 0/12 | — | — | — | — | — | — | — |
| WORK-01 | Improvements List | 0/12 | — | — | — | — | — | — | — |
| WORK-02 | Improvement Detail | 0/24 | — | — | — | — | — | — | — |
| WORK-03 | Improvement Not Found | 0/12 | — | — | — | — | — | — | — |
| WORK-04 | Room Tasks List | 0/12 | — | — | — | — | — | — | — |
| WORK-05 | Room Task Detail | 0/24 | — | — | — | — | — | — | — |
| WORK-06 | Durable Continuations | 0/24 | — | — | — | — | — | — | — |
| WORK-07 | Background Investigations | 0/24 | — | — | — | — | — | — | — |
| WORK-08 | Reviewed Contributions List | 1/12 | 1/12 | 1/12 | 1/12 | 1/12 | 1/12 | 1/12 | 1/12 |
| WORK-09 | Reviewed Contribution Detail | 0/24 | — | — | — | — | — | — | — |
| WORK-10 | Owner Diagnostics Query | 0/12 | — | — | — | — | — | — | — |
| WORK-11 | Owner Diagnostics Results | 4/24 | 3/24 | 4/24 | 4/24 | 3/24 | 4/24 | 3/24 | 3/24 |
| ROOM-01 | Room Properties — General | 0/12 | — | — | — | — | — | — | — |
| ROOM-02 | Room Properties — Agent Behavior | 0/24 | — | — | — | — | — | — | — |
| ROOM-03 | Room Summarizer Model Picker | 2/24 | 2/24 | 2/24 | 2/24 | 2/24 | 2/24 | 2/24 | 2/24 |
| ROOM-04 | Manage Room Agents — Sign In | 1/12 | 1/12 | 1/12 | 1/12 | 1/12 | 1/12 | 1/12 | 1/12 |
| ROOM-05 | Manage Room Agents — Roster | 4/24 | 4/24 | 4/24 | 4/24 | 4/24 | 4/24 | 4/24 | 4/24 |
| ROOM-06 | Manage Room Agents — Agent Detail | 0/24 | — | — | — | — | — | — | — |
| ROOM-07 | Manage Room Agents — Model Picker | 0/24 | — | — | — | — | — | — | — |
| ROOM-08 | Manage Room Agents — Conflict | 0/12 | — | — | — | — | — | — | — |
| ROOM-09 | Unsaved Changes Confirmation | 1/12 | 1/12 | 1/12 | 1/12 | 1/12 | 1/12 | 1/12 | 1/12 |
| PERSON-01 | Your Profile | 0/24 | — | — | — | — | — | — | — |
| PERSON-02 | Agent Status | 0/12 | — | — | — | — | — | — | — |
| GH-01 | GitHub — Administrator Sign In | 0/12 | — | — | — | — | — | — | — |
| GH-02 | GitHub — Claim Owner | 0/12 | — | — | — | — | — | — | — |
| GH-03 | GitHub — Connect Account | 0/12 | — | — | — | — | — | — | — |
| GH-04 | GitHub — Device Authorization | 0/12 | — | — | — | — | — | — | — |
| GH-05 | GitHub — Choose Project Repository | 12/12 | 11/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 11/12 |
| GH-06 | GitHub — Configured Repository | 0/12 | — | — | — | — | — | — | — |
| GH-07 | GitHub — Empty Repository Access | 0/12 | — | — | — | — | — | — | — |
| AUX-01 | Improvement Workshop | 0/24 | — | — | — | — | — | — | — |
| AUX-02 | Improvement Workshop Recovery | 0/12 | — | — | — | — | — | — | — |
| AUX-03 | Help | 0/12 | — | — | — | — | — | — | — |
| AUX-04 | Confirmation | 0/12 | — | — | — | — | — | — | — |

Next action: add neutral actual surface-role and scroll-region-bound context to
reduce modal/scroll-boundary misclassification, retain the unresolved judgments,
and complete current-image review before claiming a full gate pass. The agreed
viewport matrix does not certify live authentication, every state, native browser
chrome, software keyboards, text enlargement, landscape, forced colors, or physical
devices. Physical iPhone verification is not required for this acceptance matrix.

### Remediation history — 2026-08-31 (historical snapshots)

These snapshots precede the current source digest and verdict above.


WORK-01 through WORK-11 and ROOM-06 have follow-up
composition/control changes: content-sized operational panels on a gray canvas,
compact diagnostics with responsive list/detail columns, a centered recovery
panel, and shared square checkboxes adjacent to their labels. The outer workspace
still uses the available viewport. New browser assertions and measured scroll-owner
context address disputed clipping and scroll-boundary observations in CHAT-06,
WORK-02, and ROOM-03. Earlier independent failures remain intact below; neither
these changes nor geometry checks constitute visual approval. Full recapture and
fresh image review are required before this follow-up receives a verdict.

A full 714-image recapture passed every geometry check. Its initial fresh
review was interrupted after 30 images when the reviewer identified two further
stretched sparse lists (WORK-01 and WORK-04). The failed judgments and completed
receipts were retained; the partial run is not approval. These findings prompted
extension of content-sized panels to Improvements and the shared Tasks/Contributions
list before another capture and review. A third flag for WORK-08 arrived before
interruption completed and is covered by that same shared list correction.

The final recapture passed all 558 applicable scenarios (six intentional skips),
714 screenshots, and zero layout failures. The source-input digest is
`1579eccd95fb41683d409842cfc752c376d5c05c7f359300799b9b781463a433`.
Fresh review completed all 714 images: 706 passed and eight were flagged across
five views. All 21 flags from the previous full review cleared. The exact gate
failed on 20 question judgments, with no failed sessions or inconsistent verdicts
for identical image hashes. Five image flags identify palette overflow and a
repository-select styling issue; two Diagnostics boundary flags and one sign-in
spacing flag remain disputed rather than overwritten. Further shared-control
corrections are in progress, so this full review becomes historical when source
changes. The final
quality gate passed 1,129 tests with one skip across 168 files, including build,
UI contracts, and visual types. An earlier concurrent run failed the unchanged
cancellation/completion race in `server/consultation-e2e.test.ts`; its isolated
rerun and the final full gate passed. The earlier failure is retained, not
represented as an uninterrupted green run.

The next correction covers CHAT-06/07/08 and GH-05 through shared popover and
native-select rules, plus contrasting checkbox focus in WORK-06/07 and ROOM-06.
Color and smiley choices have a viewport-bounded scroll body with persistent
close control and conditional scroll cue. Native selects retain platform
selection behavior with square inset styling and touch sizing. Independent
review batches now keep the top/bottom images of each scenario together, without
changing the seven-question gate or discarding earlier failed judgments.
The focused browser run passed all 32 scenarios (48 screenshots); it is not a
complete-matrix capture or independent visual approval. Full verification is pending.

The subsequent full capture passed 558 scenarios and produced 714 images. Its
targeted independent review stopped after 173 of 270 selected images when a new
WebKit Short phone smiley-picker flag was reproduced: anchoring above a second-row
trigger obscured the font row above it. The 170 passing and three failed image
judgments remain historical, including two unchanged Tablet Background Investigations
images with disputed sparse-workspace density feedback. A new browser regression
failed before the popup fix. Shared placement now excludes the entire toolbar;
all 36 popup scenarios passed afterward. Fresh capture and image review are pending.
The popup correction's full quality gate passed 1,134 tests with one skip. An
earlier full run failed the unchanged structured-logging integration test's
temporary loopback readiness request; both its isolated rerun and the final full
gate passed. No server code was changed to address that failure.

### Previous seven-question image results — 2026-08-30 (historical)

The corrected source was recaptured at all six sizes in both engines. All 558
applicable browser scenarios passed (six intentional non-phone compact-chat
skips), producing 714 original images. Fresh local Codex sessions reviewed every
image: **693 passed all seven questions; 21 were flagged across 10 views**.
There were no failed review sessions. The exact-capture validator **failed on
65 question judgments**; this is not an overall visual approval.

Historical source-input digest (superseded by follow-up source changes):
`145c515cec4a8892e9ec45d36a99d2ad82654bd9e55114eb6b5234a01bff6699`.

Compared with the baseline, 49 flagged images cleared, seven remained flagged,
and 14 previously passing image keys received new flags. All 360 phone-size
images were reviewed: 354 passed and six were flagged. The Short phone and
Minimum phone WebKit groups each passed all 60 images. The full repository
quality gate passed 1,125 tests with one skipped.

Each cell below is **passing image judgments / captured images** for that
question, not a handwritten completion status. All 47 named views are included;
37 have passing judgments for every captured image. Detailed observations remain
in the image-bound `review.json`, with original PNGs, manifest, receipts, and
gate result retained together. Compact Room Chat has six images; ordinary views
have 12, and views with top/bottom evidence have 24. These totals do not certify
uncaptured states.

| View | Name | Screen use | Navigation | Retro style | Proportion | Empty area | Scroll/actions | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| APP-01 | Startup | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| APP-02 | Join Room | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| APP-03 | Join Recovery | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-01 | Room Chat | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-02 | Compact Room Chat | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 |
| CHAT-03 | Room Menu | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-04 | Window Menu | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-05 | Mention Suggestions | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-06 | Text Color Palette | 11/12 | 12/12 | 12/12 | 11/12 | 11/12 | 11/12 | 11/12 |
| CHAT-07 | Highlight Color Palette | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-08 | Classic Smiley Picker | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-09 | Poll Cards | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-10 | Pending Send Recovery | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| CHAT-11 | Connection and Action Notices | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| WORK-01 | Improvements List | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| WORK-02 | Improvement Detail | 23/24 | 24/24 | 24/24 | 23/24 | 24/24 | 24/24 | 23/24 |
| WORK-03 | Improvement Not Found | 10/12 | 12/12 | 12/12 | 12/12 | 10/12 | 12/12 | 10/12 |
| WORK-04 | Room Tasks List | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| WORK-05 | Room Task Detail | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 |
| WORK-06 | Durable Continuations | 19/24 | 24/24 | 24/24 | 24/24 | 20/24 | 23/24 | 19/24 |
| WORK-07 | Background Investigations | 22/24 | 24/24 | 24/24 | 24/24 | 22/24 | 24/24 | 22/24 |
| WORK-08 | Reviewed Contributions List | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| WORK-09 | Reviewed Contribution Detail | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 |
| WORK-10 | Owner Diagnostics Query | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| WORK-11 | Owner Diagnostics Results | 21/24 | 24/24 | 24/24 | 22/24 | 21/24 | 24/24 | 21/24 |
| ROOM-01 | Room Properties — General | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| ROOM-02 | Room Properties — Agent Behavior | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 |
| ROOM-03 | Room Summarizer Model Picker | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 21/24 | 21/24 |
| ROOM-04 | Manage Room Agents — Sign In | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| ROOM-05 | Manage Room Agents — Roster | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 |
| ROOM-06 | Manage Room Agents — Agent Detail | 24/24 | 24/24 | 23/24 | 23/24 | 24/24 | 24/24 | 23/24 |
| ROOM-07 | Manage Room Agents — Model Picker | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 |
| ROOM-08 | Manage Room Agents — Conflict | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| ROOM-09 | Unsaved Changes Confirmation | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| PERSON-01 | Your Profile | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 | 24/24 |
| PERSON-02 | Agent Status | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| GH-01 | GitHub — Administrator Sign In | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| GH-02 | GitHub — Claim Owner | 12/12 | 12/12 | 12/12 | 11/12 | 12/12 | 12/12 | 11/12 |
| GH-03 | GitHub — Connect Account | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| GH-04 | GitHub — Device Authorization | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| GH-05 | GitHub — Choose Project Repository | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| GH-06 | GitHub — Configured Repository | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| GH-07 | GitHub — Empty Repository Access | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| AUX-01 | Improvement Workshop | 22/24 | 24/24 | 24/24 | 22/24 | 22/24 | 24/24 | 22/24 |
| AUX-02 | Improvement Workshop Recovery | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| AUX-03 | Help | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| AUX-04 | Confirmation | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |

#### Remaining findings and dispositions

- `WORK-03`, `WORK-06`, `WORK-07`, `WORK-11`: 11 judgments question sparse
  workspace or diagnostic-payload whitespace. The full workspace, truthful
  result count where applicable, bounded content groups, visible actions, and
  end-of-content cue remain intact. These are unresolved composition judgments;
  no fictitious rows or enlarged controls were added to fill collection space.
- `ROOM-06`: one judgment objects to WebKit's native rounded Active in room
  control and its row alignment. The compact native control remains functional;
  its styling objection is not silently waived.
- Nine other judgments are disputed after original-image and implementation
  inspection: `CHAT-06` shows both complete custom-color rows above the toolbar;
  `WORK-02` shows the revision ending inside its group; the `WORK-06` alleged
  scrollbar is a partially visible button bevel, fully visible after scrolling;
  `ROOM-03` has a bidirectional settings-page cue because settings precede and
  follow the embedded picker; `GH-02` has a Claim owner button, not an unlabeled
  second password field; and `AUX-01` is content-sized with normal bottom padding.
  These notes do not replace independent failures with passes.
- Five identical-PNG top/bottom pairs received conflicting judgments: Diagnostics
  Results at Chromium Tablet/Desktop and WebKit Tablet, and Background
  Investigations at Chromium Desktop and WebKit Tablet. Matching SHA-256 values
  establish identical pixels, not which judgment is correct. Both verdicts remain
  retained; rerunning until a preferred result appears is not an approval process.

Next bounded step: adjudicate the remaining composition and native-control
styling concerns, and resolve disputed observations using their originals and
scroll-owner context. Any resulting source change requires fresh capture and
review. Do not describe this matrix as release-approved while its strict gate
fails. Physical iPhone verification is not a prerequisite for this viewport-based
acceptance.

### Earlier roster screenshot remediation — 2026-08-30

The current correction targets `ROOM-05` populated roster and `ROOM-06` agent
detail. Browser evidence now includes both ends of each pane, six viewport sizes
from 320×568 through 1440×900, and Chromium/WebKit: 24 scenarios, 48 images.

Confirmed causes and corrections:

- Intrinsically sized grid rows prevent agent contents overlapping neighboring rows.
- Dialog dimensions use the backdrop's available space, retaining balanced margins.
- Pane-width queries reflow rail headings, selected identity, and model actions.
- Primary aliases wrap; secondary metadata retains explicit ellipsis with full
  model information in detail. Detailed command explanations span the whole row.
- Text-field sizing excludes checkbox/radio controls; native glyphs stay next
  to labels, whose touch targets can be larger than the glyph.
- Back navigation and save/cancel remain outside scrolling content. A shared
  direction cue remains visible when platform-native scrollbars are hidden.

Regression checks verify primary-name containment, row heights, horizontal
overflow, centered margins, compact checkbox dimensions and label association,
model-action reflow, scroll cues, lower delete controls, keyboard toggling,
alias focus, list/detail navigation, and discard confirmation. Earlier failed
captures and image judgments remain retained; none are rewritten into approval.
Normal partial rows at a clearly indicated scroll boundary are distinguished
from content that cannot fit inside its own row.

Reproduce with `pnpm capture:visual`, then `pnpm review:visual --run <directory>`
and `pnpm check:visual-review --run <directory> --review <review.json> --receipts <receipts.json>`.
The reviewed input digest identifies the exact UI, fixture, and review criteria;
the inventory status alone never establishes approval.

Earlier local verification: all 24 browser scenarios passed, all 48 original
images received passing seven-question verdicts from fresh Codex sessions, and
the exact-capture visual validator passed. Reviewed source-input digest:
`2ec9eab34804d1388d7c1fbf18d980ed5464326ebddddb752279ab45ea8ee7dc`.
The full quality gate passed with 1,118 tests passed and one skipped. The
manifest, original PNGs, per-image verdicts, and invocation receipts are retained
together in the ignored local capture directory. A public PR must attach matching
sanitized evidence; this local record is not a production deployment claim.

Remaining coverage at that earlier digest: 45 other registered views, additional roster states such
as authentication/empty/conflict/model selection, real-device browser chrome,
on-screen keyboards, larger text, and landscape. No production-device or
app-wide visual certification is implied by this matrix.

### Application and chat

| ID | Named view | Distinct state | Status |
| --- | --- | --- | --- |
| APP-01 | Startup | Initial server loading | Unverified |
| APP-02 | Join Room | First-time name entry | Unverified |
| APP-03 | Join Recovery | Join failure, retry, and cancel | Unverified |
| CHAT-01 | Room Chat | Transcript, composer, status bar, and desktop Who’s Here rail | Unverified |
| CHAT-02 | Compact Room Chat | Narrow chat with room controls available through menus | Unverified |
| CHAT-03 | Room Menu | Room-scoped command menu | Unverified |
| CHAT-04 | Window Menu | Workspace switcher and return-to-chat navigation | Unverified |
| CHAT-05 | Mention Suggestions | Composer mention results | Unverified |
| CHAT-06 | Text Color Palette | Message text-color picker | Unverified |
| CHAT-07 | Highlight Color Palette | Message highlight-color picker | Unverified |
| CHAT-08 | Classic Smiley Picker | AIM smiley picker | Unverified |
| CHAT-09 | Poll Cards | Active room poll and voting states | Unverified |
| CHAT-10 | Pending Send Recovery | Ambiguous-send recovery bar | Unverified |
| CHAT-11 | Connection and Action Notices | Reconnect, pending action, and dismissible error strips | Unverified |

### Full workspaces

| ID | Named view | Distinct state | Status |
| --- | --- | --- | --- |
| WORK-01 | Improvements List | Active and All list tabs, including empty/loading/error | Unverified |
| WORK-02 | Improvement Detail | Existing improvement record | Unverified |
| WORK-03 | Improvement Not Found | Missing improvement recovery | Unverified |
| WORK-04 | Room Tasks List | Task list, empty, loading, and create form | Unverified |
| WORK-05 | Room Task Detail | Selected task editor and history | Unverified |
| WORK-06 | Durable Continuations | Policy control, dashboard, and continuation inbox | Unverified |
| WORK-07 | Background Investigations | Policy control, investigation lanes, and findings | Unverified |
| WORK-08 | Reviewed Contributions List | Contribution list, empty, loading, and notices | Unverified |
| WORK-09 | Reviewed Contribution Detail | Review gates and contribution detail | Unverified |
| WORK-10 | Owner Diagnostics Query | Bounded diagnostic search controls | Unverified |
| WORK-11 | Owner Diagnostics Results | Result list and selected diagnostic detail | Unverified |

### Room and participant dialogs

| ID | Named view | Distinct state | Status |
| --- | --- | --- | --- |
| ROOM-01 | Room Properties — General | Room name, topic, and conversation energy | Unverified |
| ROOM-02 | Room Properties — Agent Behavior | Base prompt, summarizer, and routing | Unverified |
| ROOM-03 | Room Summarizer Model Picker | Lazy-loaded model search, filters, and results | Unverified |
| ROOM-04 | Manage Room Agents — Sign In | Server-administrator authentication gate | Unverified |
| ROOM-05 | Manage Room Agents — Roster | Agent list, sorting, availability, and mobile master pane | Unverified |
| ROOM-06 | Manage Room Agents — Agent Detail | Selected agent identity, provider, model, and permissions | Unverified |
| ROOM-07 | Manage Room Agents — Model Picker | Provider/model selection and model detail | Unverified |
| ROOM-08 | Manage Room Agents — Conflict | Save conflict and recovery | Unverified |
| ROOM-09 | Unsaved Changes Confirmation | Destructive-close confirmation | Unverified |
| PERSON-01 | Your Profile | Name and avatar editor | Unverified |
| PERSON-02 | Agent Status | Individual agent availability, provider health, and recovery | Unverified |

2026-09-01 source-change note: `ROOM-03` and `ROOM-07` now let a member paste a
public OpenRouter model-page URL into the shared search control. A local browser
smoke check exercised the retired `stealth/ox-alpha` page and its available
`z-ai/glm-5.3-flash` replacement at Phone, Tablet, Short laptop, and Desktop
checkpoints. The lookup control, success notice, single result, return action,
and dialog actions remained reachable with no horizontal page overflow or
browser error overlay. Focused component, route, URL-validation, and bounded
provider-lookup tests cover the behavior. Account-backed independent image
review was not run, so both inventory rows remain `Unverified`.

### GitHub integration

| ID | Named view | Distinct state | Status |
| --- | --- | --- | --- |
| GH-01 | GitHub — Administrator Sign In | Existing server-owner authentication | Unverified |
| GH-02 | GitHub — Claim Owner | First-time server-owner setup | Unverified |
| GH-03 | GitHub — Connect Account | No connected GitHub account | Unverified |
| GH-04 | GitHub — Device Authorization | User code and GitHub handoff | Unverified |
| GH-05 | GitHub — Choose Project Repository | Connected account with repository selection | Unverified |
| GH-06 | GitHub — Configured Repository | Connected and configured summary | Unverified |
| GH-07 | GitHub — Empty Repository Access | No repositories available and recovery action | Unverified |

### Supporting dialogs

| ID | Named view | Distinct state | Status |
| --- | --- | --- | --- |
| AUX-01 | Improvement Workshop | Loaded improvement facts and evidence | Unverified |
| AUX-02 | Improvement Workshop Recovery | Loading, unavailable, missing, and retry states | Unverified |
| AUX-03 | Help | Navigation and room help topics | Unverified |
| AUX-04 | Confirmation | Shared confirm/cancel alert dialog | Unverified |

## Historical design judgments

The tables below preserve the earlier design rationale and use **P / T / L / D**
for Phone, Tablet, Short laptop, and Desktop. Their original “Pass” labels mixed
rendered inspection with DOM/CSS judgments and do not establish current approval.
Some described layouts have since changed. Use the current capture and per-image
seven-question review, not these historical labels, as verification evidence.

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
| ROOM-05 | P: centered, near-full viewport with 7px margins; T/L/D: centered list/detail split constrained by available backdrop space. | P: rows open detail with persistent Your agents return; T/L/D: persistent rail; Cancel/Save remain outside scrolling content. | P/T/L/D: Inset list, raised buttons, square chrome and native scrolling retained. | P: rows keep their intrinsic content height; T/L: rail header reflows within its own width; D: capped 330px rail. | P/T/L/D: Nine-agent fixture uses the rail for real content; remaining blank list area only appears when all rows fit. Empty state remains unverified. | P/T/L/D: List top/bottom captured; scroll cue indicates more content above/below; final row and detail navigation exercised. | P/T/L/D: Fixed compressed rows, balanced dialog margins and narrow rail heading; current image-bound review required, not historical approval. |
| ROOM-06 | P: detail fills single-pane space; T/L/D: flexible detail beside a 240–330px rail. | P: Your agents stays outside the scroller even at the bottom; T/L/D: rail remains available; all sizes retain close and Cancel/Save. | P/T/L/D: Native checkbox glyphs, adjacent labels, grooved groups and inset model summary; no custom scrolling implementation. | P/T: compact checkbox glyph inside larger label target; P: model action stacks; T: identity/header reflows by pane width; L/D: broader composition. | P/T/L/D: Settings groups use content-driven spacing; command labels no longer detach across wide fields. | P/T/L/D: Detail top/bottom captured; full Delete configuration group reachable; keyboard toggling, alias focus and draft discard exercised. | P/T/L/D: Fixed checkbox sizing and header collapse, added narrow model reflow and persistent scroll cue; current image-bound review required. |
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

## Historical verification record — superseded as completion evidence

- 2026-08-31, administrator recovery: `ROOM-02` now opens the existing `GH-01` sign-in dialog from a denied save, preserving the draft. The built application was exercised with real room-setting, session, and control routes in an isolated temporary room. At P/T/L/D, the recovery button and sign-in/close controls remained reachable; closing restored focus and retained the draft, with no horizontal overflow. Existing classic chrome, compact sign-in proportions, intentional background draft context, and independent body scrolling were retained; Apply/Cancel stayed fixed. Administrator sign-in followed by Apply succeeded, and saves at every checkpoint succeeded, including after a page reload. `src/room-configuration-dialog.test.tsx` covers denied saves, failed sign-in, cancellation, owner bootstrap (`GH-02`), draft preservation, and fresh administrator CSRF on retry; the unchanged bootstrap form layout retains its existing audit evidence.
- 2026-08-31, member roster authorization: `CHAT-03`, `ROOM-05`, and `ROOM-06` were exercised through the built application at P/T/L/D, using an isolated temporary room, the real roster/session/control routes, an unclaimed owner, and synthetic model discovery. At each checkpoint, Room → Manage agents opened without an administrator prompt; an alias edit saved successfully and appeared when the dialog reopened. Phone retained the Your agents back action; T/L/D retained the roster/detail split. The existing classic controls, proportions, empty-space treatment, and independent pane scrolling are unchanged; Save and Cancel remained reachable.
- The same check exercised `ROOM-07` model selection and agent creation, plus member-authorized catalog refresh. P/T/L/D dialog bounds were 362×830, 744×940, 1000×576, and 1416×876; no horizontal page overflow occurred, and footer action bottoms were 828/972/581/884 pixels within the respective viewports. A newly created agent remained present after reopening. The completed browser verification reported no errors or warnings. No live provider calls or existing room data were used.
- `ROOM-04` remains the unchanged administrator fallback for callers without member access; its sign-in interaction remains covered by `src/roster-manager.test.tsx`. Member loading/saving and the real application entry point are covered by that file and `src/reconnect-flow.test.tsx`; `src/roster-api.test.ts` checks separate member and administrator CSRF use. Server membership, denied/recovered access, owner-bootstrap independence, stale revisions, and unchanged privileged boundaries are covered by `server/roster-api.test.ts` and `server/human-session.test.ts`.
- Rendered app-frame measurements: P 378×832 at 6px equal margins; T 744×1000 at 12px; L 1000×576 at 12px; D 1400×876 at 20px horizontal and 12px vertical margins. All four reported zero page overflow.
- Rendered full-workspace measurements after correction: T 724px and L 980px view widths with only the intended 22px outer/application chrome to the right; the former 240px empty track is gone.
- Rendered Room Properties measurements confirmed persistent actions and bounded content scroll on both pages at all checkpoints. Agent Behavior content scrolls independently when its 960px phone content or 856px laptop content exceeds the available region.
- Rendered profile, Help, GitHub administrator sign-in, and Manage Agents administrator sign-in were centered and content-sized at all checkpoints. The Manage Agents sign-in changed from a 1000×576 editor-sized window to a 640×429 content-sized window at L and a 362×465 centered window at P.
- State variants and interaction contracts are covered by the focused component tests, layout-structure contract, UI standards suite, overlay tests, and reconnect-flow suite. The configured GitHub state was additionally adapted from the sibling worktree’s reported desktop/375px visual checks and re-expressed through shared primitives.

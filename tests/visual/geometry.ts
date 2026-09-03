// Runs inside page.evaluate: keep this function independent of module scope.
// Measurements supplement the original image; they are never visual verdicts.
export function measureControlDensity() {
  const issues: string[] = [];
  const touch = matchMedia("(pointer: coarse)").matches;
  const commandHeight = touch ? 44 : 26;
  const menuHeight = touch ? 44 : 20;
  const fontSize = touch ? 13 : 12;
  const visible = (element: HTMLElement) => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
  const menu = document.querySelector<HTMLElement>(".menu-bar");
  if (menu && visible(menu) && Math.abs(menu.getBoundingClientRect().height - menuHeight - 4) > 1) issues.push("The menu bar changes density with viewport size instead of input capability.");
  for (const button of document.querySelectorAll<HTMLElement>(".menu-bar > .menu-wrap > button, .dropdown-menu button")) {
    if (visible(button) && Math.abs(button.getBoundingClientRect().height - menuHeight) > 1) issues.push("A menu command has inconsistent row height.");
  }
  for (const button of document.querySelectorAll<HTMLElement>(".classic-button, .presence-footer button, .roster-explore-button, .roster-danger-zone button, .roster-mobile-back, .model-picker__filters button, .poll-card li button, .improvements-header button")) {
    if (!visible(button)) continue;
    const style = getComputedStyle(button);
    const height = button.getBoundingClientRect().height;
    const label = document.createRange();
    label.selectNodeContents(button);
    const wraps = label.getBoundingClientRect().height > parseFloat(style.lineHeight) + 1;
    if (height < commandHeight - 1 || (!wraps && Math.abs(height - commandHeight) > 1)) issues.push(`${button.textContent?.trim() || "Command"}: standard button height does not match its input density.`);
    if (parseFloat(style.fontSize) !== fontSize) issues.push("A standard command overrides the shared control typography.");
  }
  for (const control of document.querySelectorAll<HTMLElement>(".format-toolbar button, .format-toolbar select")) {
    if (visible(control) && Math.abs(control.getBoundingClientRect().height - commandHeight) > 1) issues.push("A formatting control changes height across viewport breakpoints.");
  }
  const status = document.querySelector<HTMLElement>(".status-bar");
  if (status && visible(status) && Math.abs(status.getBoundingClientRect().height - 24) > 1) issues.push("The informational status bar changes height across viewports.");
  return issues;
}

export function measureScrollRegions() {
  const modals = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter((element) => element.getClientRects().length);
  const root = modals.at(-1) || document.querySelector<HTMLElement>(".app-window") || document.body;
  return [root, ...root.querySelectorAll<HTMLElement>("*")].flatMap((element) => {
    if (!(element instanceof HTMLElement) || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) return [];
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (!/auto|scroll/.test(style.overflowY) || style.visibility === "hidden" || !element.clientHeight || !element.getClientRects().length || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return [];
    const view = element.closest<HTMLElement>("[data-view-name]")?.dataset.viewName || "Application";
    return [{ name: `${view} / ${element.classList.item(0) || element.tagName.toLowerCase()}`, offset: Math.round(element.scrollTop), maximum: Math.max(0, element.scrollHeight - element.clientHeight) }];
  });
}

// A native track or a direction-aware edge occupies no additional label row.
export function measureScrollAffordances() {
  const modals = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter((element) => element.getClientRects().length);
  const root = modals.at(-1) || document.querySelector<HTMLElement>(".app-window") || document.body;
  const issues: string[] = [];
  if (root.querySelector(".classic-scroll-hint")) issues.push("A redundant scroll-instruction row is rendered.");
  for (const element of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    if (!(element instanceof HTMLElement) || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) continue;
    const style = getComputedStyle(element);
    if (!element.getClientRects().length || !element.clientHeight || style.visibility === "hidden" || !/auto|scroll/.test(style.overflowY)) continue;
    const above = element.scrollTop > 1;
    const below = element.scrollHeight - element.clientHeight - element.scrollTop > 1;
    const expected = above && below ? "both" : above ? "above" : below ? "below" : "none";
    if (style.maskImage?.includes("transparent")) issues.push("A scroll affordance fades readable pane content.");
    if (element.dataset.scrollEdges && element.dataset.scrollEdges !== expected) issues.push("A scroll edge disagrees with its pane's actual position.");
    if (!above && !below) {
      continue;
    }
    const gutter = element.offsetWidth - element.clientWidth - (parseFloat(style.borderLeftWidth) || 0) - (parseFloat(style.borderRightWidth) || 0);
    const requiresTrack = element.closest(".classic-scrollbars") && CSS.supports("selector(::-webkit-scrollbar)") && !matchMedia("(forced-colors: active)").matches;
    const edge = element.dataset.overlayScroll === "true" && element.dataset.scrollEdges === expected && style.boxShadow?.includes("inset");
    if (gutter < 10 && requiresTrack) issues.push("An opted-in form is missing its visible native scroll track.");
    else if (gutter < 10 && !edge) issues.push(`${element.classList.item(0) || element.tagName}: overflowing content has neither a native scrollbar gutter nor a directional edge.`);
  }
  return issues;
}

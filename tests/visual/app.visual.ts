import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashBytes } from "../../scripts/visual-review";
import { APP_SCENARIOS, scenarioApplies } from "./matrix";
import { appFixtureResponse, fixtureTraceId } from "./app-fixtures";
import { measureControlDensity, measureScrollAffordances, measureScrollRegions } from "./geometry";

async function menu(page: Page, name: string, item?: string) {
  await page.getByRole("menuitem", { name, exact: true }).click();
  if (item) await page.getByRole("menu", { name }).getByRole(name === "Window" ? "menuitemradio" : "menuitem", { name: item, exact: name !== "Help" }).click();
}

async function openScenario(page: Page, id: string) {
  if (id.startsWith("server-administration")) {
    await menu(page, "Window", "Server Administration");
    await expect(page.getByRole("button", { name: id === "server-administration" ? "Sign out" : id.endsWith("unclaimed") ? "Claim owner" : "Sign in", exact: true })).toBeVisible();
  } else if (id.startsWith("room-properties") || id === "room-summarizer-model-picker") {
    await menu(page, "Room", "Room properties...");
    if (id !== "room-properties-general") await page.getByRole("tab", { name: "Agent behavior" }).click();
    if (id === "room-summarizer-model-picker") await page.getByRole("button", { name: "Choose model…" }).click();
  } else if (id.startsWith("github-")) {
    await menu(page, "Room", "GitHub integration...");
    if (id === "github-device-auth") await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  } else if (id.startsWith("manage-agents-") || id === "unsaved-changes-confirmation") {
    await menu(page, "Room", "Manage agents...");
    if (id === "manage-agents-empty") {
      await expect(page.getByText("Create your first agent", { exact: true })).toBeVisible();
      if ((page.viewportSize()?.width || 0) <= 720) await expect(page.getByRole("button", { name: "Choose a model →" })).toBeVisible();
      else await expect(page.getByRole("heading", { name: "Choose a model" })).toBeVisible();
    }
    if (id === "manage-agents-model-picker") await page.getByRole("button", { name: "＋ Add another agent" }).click();
    if (id === "manage-agents-conflict" || id === "unsaved-changes-confirmation") {
      await page.getByRole("button", { name: "View Alpha configuration" }).click();
      await page.getByRole("textbox", { name: "Agent alias", exact: true }).fill("Alpha navigation");
      await page.getByRole("button", { name: id === "manage-agents-conflict" ? "Save roster" : "Cancel", exact: true }).click();
    }
  } else if (id.startsWith("your-profile")) await menu(page, "You", "Profile...");
  else if (id === "help") await menu(page, "Help", "Help topics");
  else if (id === "room-menu") await menu(page, "Room");
  else if (id === "window-menu") await menu(page, "Window");
  else if (id === "mention-suggestions") await page.getByRole("textbox", { name: "Message", exact: true }).fill("@");
  else if (["text-color-palette", "highlight-color-palette", "classic-smiley-picker"].includes(id)) await page.getByRole("button", { name: id === "text-color-palette" ? "Text color" : id === "highlight-color-palette" ? "Message highlight color" : "Classic emojis", exact: true }).click();
  else if (["improvements-list", "improvement-detail"].includes(id)) {
    await menu(page, "Window", "Improvements");
    if (id === "improvement-detail") await page.getByRole("link", { name: "navigation-review", exact: true }).click();
  } else if (["room-tasks-list", "room-task-detail"].includes(id)) {
    await menu(page, "Window", "Tasks");
    if (id === "room-task-detail") await page.getByRole("button", { name: /Review navigation across screen sizes/ }).click();
  } else if (id === "durable-continuations") await menu(page, "Window", "Continuations");
  else if (id === "background-investigations") await menu(page, "Window", "Investigations");
  else if (id.startsWith("reviewed-contribution")) {
    await menu(page, "Window", "Reviewed contributions");
    if (id === "reviewed-contribution-detail") await page.getByRole("button", { name: /Consistent navigation controls/ }).click();
  } else if (id.startsWith("owner-diagnostics")) {
    await menu(page, "Window", "Diagnostics");
    if (id === "owner-diagnostics-sign-in") {
      await page.getByRole("button", { name: "Query diagnostics", exact: true }).click();
      await expect(page.getByRole("alert")).toBeVisible();
    }
    if (id === "owner-diagnostics-results") {
      await page.getByLabel("Diagnostic selector").selectOption("traceId");
      await page.getByLabel("Trace ID").fill(fixtureTraceId);
      await page.getByRole("button", { name: "Query diagnostics", exact: true }).click();
      await page.getByRole("button", { name: /conversation\.turn\.finished/ }).click();
    }
  }
}

async function capture(page: Page, info: TestInfo, scenario: typeof APP_SCENARIOS[number], shot: string) {
  // Let native scrolling and decoration settle. Persistent failures are still
  // recorded below, with their screenshot, rather than losing the evidence here.
  await expect.poll(() => page.evaluate(measureScrollAffordances), { timeout: 1500 }).toEqual([]).catch(() => undefined);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const runDirectory = process.env.VISUAL_RUN_DIRECTORY;
  if (!runDirectory) throw new Error("Run this suite through pnpm capture:visual.");
  const key = `${info.project.name}--${scenario.id}--${shot}`;
  const actualViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(actualViewport).toEqual(info.project.use.viewport);
  const layoutIssues = await page.evaluate(() => {
    const issues: string[] = [];
    const visible = (el: HTMLElement) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
    const contained = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; };
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push("Page has horizontal overflow.");
    for (const button of document.querySelectorAll<HTMLElement>(".administration-sign-in")) {
      if (!visible(button)) continue;
      if (button.parentElement!.getBoundingClientRect().width > 360 && button.getBoundingClientRect().width > 320) issues.push("The sign-in command is stretched across its panel.");
    }
    for (const dialog of document.querySelectorAll<HTMLElement>('.github-integration-window[data-presentation="authentication"], .roster-window[data-presentation="authentication"]')) {
      if (visible(dialog) && innerWidth > 720 && dialog.getBoundingClientRect().width > 441) issues.push("A short sign-in dialog exceeds its content-sized width.");
    }
    for (const navigation of document.querySelectorAll<HTMLElement>(".room-model-selection__navigation")) {
      const pane = navigation.closest<HTMLElement>(".room-properties-page-content");
      if (!visible(navigation) || !pane) continue;
      const boundary = pane.getBoundingClientRect().top;
      if (navigation.parentElement!.getBoundingClientRect().top < boundary && navigation.getBoundingClientRect().top > boundary + 1) issues.push("Scrolled model filters can peek above the sticky Back row.");
    }
    for (const hidden of document.querySelectorAll<HTMLElement>('[hidden]:not([hidden="until-found"])')) {
      if (hidden.getClientRects().length) issues.push("An inactive hidden element still occupies layout space.");
    }
    for (const toolbar of document.querySelectorAll<HTMLElement>(".format-toolbar")) {
      if (!visible(toolbar)) continue;
      const bounds = toolbar.getBoundingClientRect();
      for (const control of toolbar.querySelectorAll<HTMLElement>("button, select")) {
        const r = control.getBoundingClientRect();
        if (r.left < bounds.left - 1 || r.right > bounds.right + 1 || r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1 || !contained(control)) issues.push("A formatting control is clipped or outside its toolbar.");
      }
    }
    for (const name of document.querySelectorAll<HTMLElement>(".presence-row .speaker")) {
      if (visible(name) && (name.scrollWidth > name.clientWidth + 1 || name.scrollHeight > name.clientHeight + 1)) issues.push("A primary roster identity is truncated.");
    }
    const mentionPopup = document.querySelector<HTMLElement>(".mention-suggestions");
    if (mentionPopup) {
      if (!contained(mentionPopup)) issues.push("Mention suggestions extend outside the viewport.");
      if (mentionPopup.getBoundingClientRect().bottom > document.querySelector(".format-toolbar")!.getBoundingClientRect().top) issues.push("Mention suggestions obscure the formatting toolbar.");
      for (const name of mentionPopup.querySelectorAll<HTMLElement>('[role="option"] strong')) {
        if (name.scrollWidth > name.clientWidth + 1) issues.push("A primary mention identity is truncated.");
      }
    }
    for (const filters of document.querySelectorAll<HTMLElement>(".model-picker__filters")) {
      if (visible(filters) && filters.scrollWidth > filters.clientWidth + 1) issues.push("Model filters require hidden horizontal scrolling.");
    }
    for (const section of document.querySelectorAll<HTMLElement>(".room-configuration-card")) {
      if (!visible(section)) continue;
      const style = getComputedStyle(section);
      if (parseFloat(style.fontSize) > 12 || parseFloat(getComputedStyle(section.querySelector("h3")!).fontSize) > 13) issues.push("Agent Behavior overrides compact property-sheet typography.");
      if ([style.borderLeftWidth, style.borderRightWidth, style.borderBottomWidth].some((width) => parseFloat(width) > 0)) issues.push("Agent Behavior adds nested section frames instead of shared separators.");
      for (const editor of section.querySelectorAll<HTMLTextAreaElement>("textarea")) {
        if (editor.getBoundingClientRect().height > 88 || getComputedStyle(editor).resize !== "vertical") issues.push("A prompt editor is oversized by default or cannot be resized.");
      }
    }
    const basePromptToggle = document.querySelector<HTMLInputElement>('.room-configuration-card input[type="checkbox"]');
    if (basePromptToggle && visible(basePromptToggle)) {
      const style = getComputedStyle(basePromptToggle);
      if (style.appearance !== "none" || basePromptToggle.getBoundingClientRect().width !== 16) issues.push("Agent Behavior bypasses the shared classic checkbox.");
    }
    const resetPrompt = document.querySelector<HTMLElement>(".room-configuration-card .classic-field-heading button");
    if (resetPrompt && visible(resetPrompt) && resetPrompt.getBoundingClientRect().width > resetPrompt.closest("section")!.clientWidth * .7) issues.push("The prompt reset stretches into a full-width command row.");
    const modelSummary = document.querySelector<HTMLElement>(".room-configuration-model");
    if (modelSummary && visible(modelSummary)) {
      const name = modelSummary.querySelector("strong")!.getBoundingClientRect();
      const action = modelSummary.querySelector("button")!.getBoundingClientRect();
      if (action.left < name.right || action.top > name.bottom || action.bottom < name.top) issues.push("The summarizer action is detached from its model summary.");
    }
    const roster = document.querySelector<HTMLElement>('.roster-window[data-presentation="roster"]');
    const chat = document.querySelector<HTMLElement>(".chat-panel");
    if (roster && chat && visible(roster) && roster.getBoundingClientRect().height <= chat.getBoundingClientRect().height) {
      issues.push("Manage Room Agents does not use more vertical workspace than the chat pane.");
    }
    const palette = document.querySelector<HTMLElement>(".aim-color-picker");
    if (palette) {
      const bounds = palette.getBoundingClientRect();
      const body = palette.querySelector<HTMLElement>(".classic-popover__body")!;
      if (body.scrollHeight > body.clientHeight + 1) issues.push("The palette introduces unnecessary vertical scrolling at a supported viewport.");
      for (const swatch of palette.querySelectorAll<HTMLElement>(".aim-color-swatch")) {
        const rect = swatch.getBoundingClientRect();
        if (rect.top < bounds.top || rect.bottom > bounds.bottom || !contained(swatch)) issues.push("A palette swatch is clipped by its popover or viewport.");
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (!hit || !swatch.contains(hit)) issues.push("A palette swatch is covered by another control.");
      }
    }
    for (const popup of document.querySelectorAll<HTMLElement>(".classic-popover")) {
      if (!contained(popup)) issues.push("A formatting popover exceeds the viewport.");
      const body = popup.querySelector<HTMLElement>(".classic-popover__body")!;
      if (body.scrollWidth > body.clientWidth + 1) issues.push("A formatting popover requires horizontal scrolling.");
    }
    for (const content of document.querySelectorAll<HTMLElement>(".workspace-content, .tasks-body > .task-list")) {
      const last = content.lastElementChild?.getBoundingClientRect();
      if (last && content.getBoundingClientRect().bottom - last.bottom > 32) issues.push("A workspace content panel stretches empty space below its final element.");
    }
    for (const value of document.querySelectorAll<HTMLElement>(".improvements-status dd, .continuation-body .task-card")) {
      if (value.scrollWidth > value.clientWidth + 1) issues.push("A workspace record or action overflows its row horizontally.");
      if (value.matches("dd") && !value.children.length) {
        const range = document.createRange(); range.selectNodeContents(value);
        const bounds = value.getBoundingClientRect();
        if ([...range.getClientRects()].some((rect) => rect.left < bounds.left - 1 || rect.right > bounds.right + 1)) issues.push("Improvement metadata text is clipped by its field.");
      }
    }
    for (const payload of document.querySelectorAll<HTMLElement>(".diagnostic-record-detail > pre")) {
      const range = document.createRange(); range.selectNodeContents(payload);
      const style = getComputedStyle(payload);
      const naturalHeight = range.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      if (payload.clientHeight > naturalHeight + 24) issues.push("A diagnostic payload stretches empty space beyond its text.");
    }
    for (const results of document.querySelectorAll<HTMLElement>(".model-picker__results")) {
      if (visible(results) && /auto|scroll/.test(getComputedStyle(results).overflowY)) issues.push("Model results introduce a nested scrolling region.");
    }
    for (const title of document.querySelectorAll<HTMLElement>(".model-card__heading > strong")) {
      const text = title.firstChild;
      if (!visible(title) || text?.nodeType !== Node.TEXT_NODE) continue;
      for (const word of (text.textContent || "").matchAll(/\b[A-Za-z]{2,12}\b/g)) {
        const range = document.createRange();
        range.setStart(text, word.index!);
        range.setEnd(text, word.index! + word[0].length);
        if (range.getClientRects().length > 1) issues.push("A model name breaks inside an ordinary word.");
      }
    }
    for (const header of document.querySelectorAll<HTMLElement>(".task-card__top")) {
      const title = header.querySelector("strong")?.getBoundingClientRect();
      const badge = header.querySelector(".task-state")?.getBoundingClientRect();
      if (title && badge && title.left < badge.right && title.right > badge.left && title.top < badge.bottom && title.bottom > badge.top) issues.push("A task status badge overlaps its title.");
    }
    for (const composer of document.querySelectorAll<HTMLElement>(".composer")) {
      if (!visible(composer)) continue;
      const bounds = composer.getBoundingClientRect();
      for (const control of composer.querySelectorAll<HTMLElement>("textarea, .send-button")) {
        const r = control.getBoundingClientRect();
        if (r.bottom > bounds.bottom + 1 || !contained(control)) issues.push("The composer input or Send action exceeds its allocated space.");
      }
      const input = composer.querySelector("textarea")!.getBoundingClientRect();
      const send = composer.querySelector(".send-button")!.getBoundingClientRect();
      const commandBand = composer.querySelector(".format-toolbar")!.getBoundingClientRect();
      const style = getComputedStyle(composer);
      if (send.bottom > input.top + 1 || input.width < composer.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 1) issues.push("Send reserves an empty side column instead of sharing the command band above a full-width message field.");
      if (Math.abs(send.bottom - commandBand.bottom) > 1) issues.push("Send is not aligned with the formatting command row.");
      const status = document.querySelector<HTMLElement>(".status-bar");
      if (status && bounds.bottom > status.getBoundingClientRect().top + 1) issues.push("The composer overlaps the status bar.");
    }
    const toolbar = document.querySelector<HTMLElement>(".format-toolbar")?.getBoundingClientRect();
    for (const popup of document.querySelectorAll<HTMLElement>(".classic-popover")) {
      if (!toolbar || !visible(popup)) continue;
      const bounds = popup.getBoundingClientRect();
      if (bounds.top < toolbar.bottom && bounds.bottom > toolbar.top) issues.push("A formatting popup overlaps the formatting toolbar.");
    }
    for (const el of document.querySelectorAll<HTMLElement>(".app-window, .loading-window, .dialog-window, .workspace-surface__titlebar, .status-bar, .dialog-titlebar, .dialog-actions")) {
      if (visible(el) && !contained(el)) issues.push(`${el.className} extends outside the viewport.`);
    }
    for (const el of document.querySelectorAll<HTMLElement>(".dialog-body, .workspace-view__body, .chat-panel, .dialog-window")) {
      if (visible(el) && el.scrollWidth > el.clientWidth + 1) issues.push(`${el.className} has horizontal overflow (${el.scrollWidth}/${el.clientWidth}).`);
    }
    return issues;
  });
  layoutIssues.push(...await page.evaluate(measureScrollAffordances));
  layoutIssues.push(...await page.evaluate(measureControlDensity));
  const scrollRegions = await page.evaluate(measureScrollRegions);
  const screenshot = await page.screenshot({ animations: "disabled", fullPage: false });
  writeFileSync(resolve(runDirectory, "screenshots", `${key}.png`), screenshot);
  writeFileSync(resolve(runDirectory, `${key}.json`), JSON.stringify({ key, viewId: scenario.view.id, engine: info.project.use.browserName, viewport: actualViewport, screenshotSha256: hashBytes(screenshot), layoutIssues, scrollRegions }, null, 2));
  await info.attach(key, { body: screenshot, contentType: "image/png" });
  expect.soft(layoutIssues, key).toEqual([]);
}

for (const scenario of APP_SCENARIOS) {
  test(scenario.id, async ({ page }, info) => {
    test.skip(!scenarioApplies(scenario, info.project.use.viewport!), "Compact chat is only rendered at narrow widths.");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://127.0.0.1:4187") return route.abort();
      if (url.pathname.startsWith("/api/")) {
        const response = appFixtureResponse(url.href, route.request().method(), scenario.id);
        if (response.status === 501) errors.push(`Unmocked API: ${route.request().method()} ${url.pathname}`);
        return route.fulfill({ status: response.status, json: response.body });
      }
      return route.continue();
    });
    await page.goto(`/tests/visual/index.html?scenario=${scenario.id}`);
    if (scenario.view.category !== "application") await expect(page.locator(".app-window")).toBeVisible();
    await openScenario(page, scenario.id);
    if (scenario.id === "room-properties-general") {
      const dialog = page.getByRole("dialog", { name: "Room Properties" });
      const general = page.getByRole("tab", { name: "General", exact: true });
      const behavior = page.getByRole("tab", { name: "Agent behavior", exact: true });
      const initialBounds = await dialog.boundingBox();
      const initialActions = await dialog.getByRole("button", { name: "Cancel", exact: true }).boundingBox();
      await expect(general).toHaveCSS("border-bottom-width", "0px");
      await expect(behavior).toHaveCSS("border-bottom-color", "rgb(255, 255, 255)");
      await expect(dialog.locator(".room-properties-general-content")).toHaveCSS("font-size", "12px");
      const generalAppearance = await dialog.locator(".room-properties-general-content").evaluate((element) => {
        const style = getComputedStyle(element);
        return { padding: style.padding, font: style.font, background: style.backgroundColor };
      });
      await behavior.click();
      await expect(behavior).toHaveCSS("border-bottom-width", "0px");
      await expect(general).toHaveCSS("border-bottom-color", "rgb(255, 255, 255)");
      await expect(dialog.getByRole("heading", { name: "Summarizer", exact: true })).toBeVisible();
      expect(await dialog.locator("#room-properties-agent-panel .room-properties-page-content").evaluate((element) => {
        const style = getComputedStyle(element);
        return { padding: style.padding, font: style.font, background: style.backgroundColor };
      })).toEqual(generalAppearance);
      expect(await dialog.boundingBox()).toEqual(initialBounds);
      expect(await dialog.getByRole("button", { name: "Cancel", exact: true }).boundingBox()).toEqual(initialActions);
      await expect(dialog.locator("#room-properties-general-panel")).toHaveCSS("display", "none");
      await general.click();
      await expect(dialog.locator("#room-properties-agent-panel")).toHaveCSS("display", "none");
      expect(await dialog.boundingBox()).toEqual(initialBounds);
      await expect(dialog.getByRole("textbox", { name: "Room name", exact: true })).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("button", { name: "OK", exact: true })).toHaveCount(1);
      // Capture General after the behavior page has loaded, not just on first open.
    }
    const surface = page.locator(`[data-view-id="${scenario.view.id}"], [data-responsive-view-id="${scenario.view.id}"]`).first();
    await expect(surface).toBeVisible();
    if (scenario.id === "room-summarizer-model-picker") await expect(surface.locator('.model-picker__toolbar input')).toBeInViewport({ ratio: 1 });
    await expect(page.getByText(/^(Loading roster…|Loading configuration…|Loading settings…|Loading contribution…|Loading tasks…|Loading improvements…)$/)).toHaveCount(0);
    if (scenario.id === "improvement-not-found") await expect(page.getByRole("region", { name: "Bounded heartbeat controls" })).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    await capture(page, info, scenario, "top");
    if (scenario.id === "room-properties-agent-behavior") {
      const toggle = page.getByRole("checkbox", { name: "Include a room base prompt" });
      await toggle.focus();
      await toggle.press("ArrowRight");
      await expect(toggle).toHaveCSS("outline-style", "dotted");
      await toggle.press("Space");
      await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeDisabled();
      await toggle.press("Space");
      await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeEnabled();
    }
    if (scenario.id === "room-summarizer-model-picker") await expect(page.getByRole("button", { name: "Back to agent behavior", exact: true })).toBeInViewport({ ratio: 1 });
    if (scenario.shots.includes("bottom")) {
      await surface.evaluate((root, pickerOnly) => {
        const boundary = pickerOnly ? root : root.closest(".dialog-window, .workspace-view") || root;
        for (const el of [boundary, ...boundary.querySelectorAll<HTMLElement>("*")]) {
          if (el instanceof HTMLElement && /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
        }
        if (pickerOnly) root.scrollIntoView({ block: "end", behavior: "instant" });
      }, scenario.id === "room-summarizer-model-picker");
      await capture(page, info, scenario, "bottom");
    }
    if (["room-summarizer-model-picker", "manage-agents-model-picker"].includes(scenario.id) && info.project.use.viewport!.width <= 720) {
      const filter = surface.getByRole("combobox", { name: "Filter models", exact: true });
      await expect(filter).toBeVisible();
      await filter.selectOption("tools");
      await expect(filter).toHaveValue("tools");
    }
    if (scenario.id === "room-summarizer-model-picker") {
      const back = page.getByRole("button", { name: "Back to agent behavior", exact: true });
      await expect(back).toBeInViewport({ ratio: 1 });
      await back.click();
      await expect(surface).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Choose model…", exact: true })).toBeFocused();
    }
    if (["durable-continuations", "background-investigations"].includes(scenario.id)) {
      const policy = surface.getByRole("checkbox");
      await policy.focus();
      // Enter keyboard modality without mutating this read-only policy fixture.
      // WebKit's Tab traversal depends on the host's full-keyboard-access setting.
      await policy.press("ArrowRight");
      await expect(policy).toBeFocused();
      await expect(policy).toHaveCSS("outline-style", "dotted");
      await expect(policy).toHaveCSS("box-shadow", /rgb\(255, 255, 255\)/);
    }
    if (scenario.id === "github-choose-repo") {
      const repository = surface.getByRole("combobox", { name: "Repository", exact: true });
      await expect(repository).toHaveCSS("border-radius", "0px");
      if (info.project.use.viewport!.width <= 820) expect((await repository.boundingBox())!.height).toBeGreaterThanOrEqual(40);
      await repository.selectOption(await repository.inputValue());
      const useRepository = surface.getByRole("button", { name: "Use repository", exact: true });
      await useRepository.focus();
      await expect(useRepository).toBeInViewport({ ratio: 1 });
    }
    if (["text-color-palette", "highlight-color-palette", "classic-smiley-picker"].includes(scenario.id)) {
      // Supplemental popover stress check, not a full-app acceptance viewport.
      const originalViewport = page.viewportSize()!;
      await page.setViewportSize({ width: 320, height: 200 });
      const body = surface.locator(".classic-popover__body");
      await expect(surface.locator(".classic-popover-header button")).toBeInViewport({ ratio: 1 });
      await expect.poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      // Native resize/scroll notifications update edge decoration after layout.
      await expect.poll(() => page.evaluate(measureScrollAffordances)).toEqual([]);
      await expect.poll(() => body.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(body.getByRole("button").last()).toBeInViewport({ ratio: 1 });
      expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
      await page.setViewportSize(originalViewport);
      await expect.poll(() => body.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    }
    const closePopover = { "text-color-palette": "Close Text color", "highlight-color-palette": "Close Message highlight", "classic-smiley-picker": "Close Smileys", "mention-suggestions": "Close Mentions" }[scenario.id];
    if (closePopover) {
      await page.getByRole("button", { name: closePopover, exact: true }).click();
      await expect(surface).toHaveCount(0);
    }
    if (scenario.id === "connection-notices") {
      await page.getByRole("button", { name: "Dismiss error" }).click();
      await expect(surface).toHaveCount(0);
    }
    // Every workspace must retain a visible, functioning route back to Chat.
    const exit = page.getByRole("button", { name: /^Close .* and return to Chat$/ });
    if (await exit.count()) {
      await expect(exit).toBeInViewport({ ratio: 1 });
      await exit.click();
      await expect(page.locator(".chat-panel")).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}

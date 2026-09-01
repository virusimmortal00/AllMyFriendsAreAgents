import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashBytes } from "../../scripts/visual-review";
import { visualRoster } from "./fixtures";
import { ROSTER_SCENARIOS as VISUAL_SCENARIOS } from "./matrix";
import { measureControlDensity, measureScrollAffordances, measureScrollRegions } from "./geometry";

async function capture(page: Page, info: TestInfo, scenario: (typeof VISUAL_SCENARIOS)[number], shot: string) {
  // Retain the screenshot and normal failure record if the state never settles.
  await expect.poll(() => page.evaluate(measureScrollAffordances), { timeout: 1500 }).toEqual([]).catch(() => undefined);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const runDirectory = process.env.VISUAL_RUN_DIRECTORY;
  if (!runDirectory) throw new Error("Run this suite through pnpm capture:visual.");
  const key = `${info.project.name}--${scenario.id}--${shot}`;
  const actualViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(actualViewport).toEqual(info.project.use.viewport);
  const layoutIssues = await page.evaluate(() => {
    const issues: string[] = [];
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const bounds = dialog.getBoundingClientRect();
    if (bounds.x < 0 || bounds.y < 0 || bounds.right > innerWidth + 1 || bounds.bottom > innerHeight + 1) issues.push("Dialog extends outside the viewport.");
    if (Math.abs(bounds.left - (innerWidth - bounds.right)) > 2 || Math.abs(bounds.top - (innerHeight - bounds.bottom)) > 2) issues.push("Dialog has unbalanced viewport margins.");
    const title = dialog.querySelector<HTMLElement>(".dialog-titlebar")!.getBoundingClientRect();
    const footer = dialog.querySelector<HTMLElement>(".dialog-actions")!.getBoundingClientRect();
    if (title.top < 0 || footer.bottom > innerHeight + 1) issues.push("Title or actions are clipped.");
    if (document.documentElement.scrollWidth > innerWidth) issues.push("Page has horizontal overflow.");
    for (const wrapper of dialog.querySelectorAll<HTMLElement>(".roster-body, .roster-rail, .roster-detail-pane, .roster-config-header")) {
      const style = getComputedStyle(wrapper);
      if ([style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some((width) => parseFloat(width) > 0)) issues.push("A layout-only roster wrapper adds a redundant nested border.");
    }
    const listStyle = getComputedStyle(dialog.querySelector<HTMLElement>(".roster-editor")!);
    if (listStyle.borderTopStyle !== "inset") issues.push("The roster collection lost its single classic inset boundary.");
    for (const pane of dialog.querySelectorAll<HTMLElement>(".roster-editor, .roster-detail-pane")) {
      if (!pane.getClientRects().length) continue;
      if (pane.scrollWidth > pane.clientWidth + 1) issues.push(`${pane.className} has horizontal overflow (${pane.scrollWidth}px content / ${pane.clientWidth}px pane).`);
    }
    const detail = dialog.querySelector<HTMLElement>(".roster-detail-pane")!;
    if (detail.getClientRects().length) {
      const alias = detail.querySelector<HTMLElement>(".roster-config-identity input")!;
      if (alias.getBoundingClientRect().width < 100) issues.push("Selected agent identity is squeezed out of its header.");
      if (innerWidth > 720) {
        const rail = dialog.querySelector<HTMLElement>(".roster-rail")!;
        if (Math.abs(rail.getBoundingClientRect().bottom - detail.getBoundingClientRect().bottom) > 2) issues.push("The roster and detail panes do not end together.");
        if (getComputedStyle(dialog.querySelector<HTMLElement>(".roster-body")!).backgroundColor !== getComputedStyle(detail).backgroundColor) issues.push("The property sheet exposes a contrasting canvas around its form.");
        if (detail.scrollHeight <= detail.clientHeight + 1) {
          const danger = detail.querySelector<HTMLElement>(".roster-danger-zone")!.getBoundingClientRect();
          const style = getComputedStyle(detail);
          if (detail.getBoundingClientRect().bottom - parseFloat(style.paddingBottom) - danger.bottom > 2) issues.push("The taller detail pane leaves unused space below its destructive section.");
        }
      }
      for (const checkbox of detail.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
        const box = checkbox.getBoundingClientRect();
        if (box.width > 22 || box.height > 22) issues.push("Checkbox inherits text-field sizing.");
        const label = checkbox.closest("label")!;
        if (getComputedStyle(checkbox).appearance !== "none" || getComputedStyle(checkbox).borderRadius !== "0px") issues.push("Checkbox does not use the shared square classic control.");
        if ((getComputedStyle(checkbox, "::after").visibility === "visible") !== checkbox.checked) issues.push("Checkbox decoration disagrees with its actual checked state.");
        const text = [...label.childNodes].find((node) => node !== checkbox && node.textContent?.trim());
        if (text) {
          const range = document.createRange();
          range.selectNodeContents(text);
          if (range.getBoundingClientRect().left - box.right > 12) issues.push("Checkbox label is detached from its control.");
        }
      }
      const model = detail.querySelector<HTMLElement>(".roster-current-model")!;
      const detailedCommand = detail.querySelector<HTMLElement>(".roster-command--detailed")!;
      const descriptionId = detailedCommand.querySelector("input")!.getAttribute("aria-describedby")!;
      const commandExplanation = document.getElementById(descriptionId)!;
      if (commandExplanation.scrollWidth > commandExplanation.clientWidth + 1 || commandExplanation.scrollHeight > commandExplanation.clientHeight + 1) issues.push("Detailed command explanation is clipped inside its control.");
      const description = model.querySelector("small")!.getBoundingClientRect();
      const change = model.querySelector("button")!.getBoundingClientRect();
      if (change.left < description.right && change.right > description.left && change.top < description.bottom && change.bottom > description.top) issues.push("The model action overlaps its description.");
      if (detail.querySelector<HTMLElement>(".roster-config-workspace")!.clientWidth <= 360) {
        const danger = detail.querySelector<HTMLElement>(".roster-danger-zone")!;
        const explanation = danger.querySelector("small")!.getBoundingClientRect();
        const action = danger.querySelector("button")!.getBoundingClientRect();
        if (explanation.top < action.bottom || explanation.width < danger.clientWidth - 16) issues.push("The narrow delete action squeezes its explanation instead of giving it a full-width row.");
      }
    }
    const rows = [...dialog.querySelectorAll<HTMLElement>(".roster-editor-row")];
    for (const [index, row] of rows.entries()) {
      if (!row.getClientRects().length) continue;
      const box = row.getBoundingClientRect();
      const button = row.querySelector<HTMLElement>(".roster-agent-select")!.getBoundingClientRect();
      if (box.height + 1 < button.height || button.bottom > box.bottom + 1) issues.push(`Roster row ${index + 1} is shorter than its content.`);
      const name = row.querySelector<HTMLElement>(".speaker")!;
      if (name.scrollWidth > name.clientWidth + 1 || name.scrollHeight > name.clientHeight + 1) issues.push(`Roster row ${index + 1} truncates its primary identity.`);
      const next = rows[index + 1]?.getBoundingClientRect();
      if (next && button.bottom > next.top + 1) issues.push(`Roster row ${index + 1} overlaps the next row.`);
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

for (const scenario of VISUAL_SCENARIOS) {
  test(scenario.id, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      // No production API, credentials, external models, or room state are used.
      if (url.origin !== "http://127.0.0.1:4187") return route.abort();
      if (url.pathname === "/api/roster" && route.request().method() === "GET") return route.fulfill({ json: { roster: visualRoster, catalog: [] } });
      if (url.pathname.startsWith("/api/")) throw new Error(`Unmocked fixture API: ${route.request().method()} ${url.pathname}`);
      return route.continue();
    });
    await page.goto(`/tests/visual/index.html?scenario=${scenario.id}`);
    await page.getByRole("button", { name: "Open roster fixture" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage room agents" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Loading roster…", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("6 active · 9 configured")).toBeAttached();
    await expect(page.locator(`[data-view-id="${scenario.view.id}"]`)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await capture(page, info, scenario, "top");
    if (scenario.id === "roster-detail") {
      const pane = await dialog.locator(".roster-detail-pane").boundingBox();
      const change = await dialog.getByRole("button", { name: "Change model", exact: true }).boundingBox();
      expect(pane).not.toBeNull();
      expect(change).not.toBeNull();
      expect(change!.y + change!.height).toBeLessThanOrEqual(pane!.y + pane!.height);
      const viewport = page.viewportSize()!;
      if (viewport.width >= 768 || viewport.height >= 844) {
        expect(await dialog.locator(".roster-detail-pane").evaluate((element) => element.scrollHeight - element.clientHeight), "The default form should fit at regular phone, tablet, laptop, and desktop sizes.").toBeLessThanOrEqual(1);
      }
    }
    if (scenario.id === "roster-populated") {
      const list = page.getByRole("list", { name: "Room agent roster" });
      await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(page.getByRole("button", { name: "View Iota configuration" })).toBeInViewport();
      await capture(page, info, scenario, "bottom");
      await page.getByRole("button", { name: "View Iota configuration" }).click();
      await expect(page.getByRole("switch", { name: "Active in room for Iota" })).toBeVisible();
      if ((page.viewportSize()?.width || 0) <= 720) {
        await page.getByRole("button", { name: "← Your agents" }).click();
        await expect(list).toBeVisible();
      }
    } else {
      const detail = page.locator(".roster-detail-pane");
      await detail.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      const remove = dialog.getByRole("button", { name: "Delete agent…", exact: true });
      await expect(remove).toBeInViewport({ ratio: 1 });
      await expect(dialog.locator(".roster-danger-zone")).toBeInViewport({ ratio: 1 });
      expect(await detail.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
      if ((page.viewportSize()?.width || 0) <= 720) await expect(dialog.getByRole("button", { name: "← Your agents" })).toBeInViewport({ ratio: 1 });
      await capture(page, info, scenario, "bottom");
      // Prove real focus/keyboard access, not only a programmatic scroll offset.
      const allowAll = dialog.getByRole("checkbox", { name: "Allow all commands", exact: true });
      await allowAll.focus();
      await allowAll.press("Space");
      await expect(allowAll).toBeChecked();
      await allowAll.press("Space");
      await expect(allowAll).not.toBeChecked();
      const active = dialog.getByRole("switch", { name: "Active in room for Alpha", exact: true });
      await active.focus();
      await active.press("Space");
      await expect(active).not.toBeChecked();
      expect(await active.evaluate((element) => getComputedStyle(element, "::after").visibility)).toBe("hidden");
      await active.press("Space");
      await expect(active).toBeChecked();
      expect(await active.evaluate((element) => getComputedStyle(element, "::after").visibility)).toBe("visible");
      await expect(active).toHaveCSS("outline-style", "dotted");
      await expect(active).toHaveCSS("box-shadow", /rgb\(255, 255, 255\)/);
      expect(await active.evaluate((element) => {
        const control = element.getBoundingClientRect();
        const pane = element.closest(".roster-detail-pane")!.getBoundingClientRect();
        return control.left - 4 >= pane.left && control.top - 4 >= pane.top
          && control.right + 4 <= pane.right && control.bottom + 4 <= pane.bottom;
      }), "The focused checkbox needs clearance for its four-pixel focus treatment.").toBe(true);
      await dialog.getByRole("textbox", { name: "Agent alias", exact: true }).focus();
      await expect(dialog.getByRole("textbox", { name: "Agent alias", exact: true })).toBeInViewport({ ratio: 1 });
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    if (scenario.id === "roster-detail") {
      await page.getByRole("alertdialog", { name: "Discard roster changes?" }).getByRole("button", { name: "Discard changes", exact: true }).click();
    }
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

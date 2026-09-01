import { expect, test } from "@playwright/test";
import { appFixtureResponse } from "./app-fixtures";
import { measureControlDensity } from "./geometry";

test("control density remains stable across resize boundaries and views", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4187") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      const response = appFixtureResponse(url.href, route.request().method(), "room-chat");
      if (response.status === 501) errors.push(`Unmocked API: ${route.request().method()} ${url.pathname}`);
      return route.fulfill({ status: response.status, json: response.body });
    }
    return route.continue();
  });
  await page.goto("/tests/visual/index.html?scenario=room-chat");
  await expect(page.locator(".app-window")).toBeVisible();
  const pointerIsCoarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  for (const [width, height] of [[1440, 900], [1024, 600], [821, 700], [820, 700], [721, 700], [720, 700], [390, 844], [390, 568], [320, 568]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(pointerIsCoarse);
    expect(await page.evaluate(measureControlDensity), `${width}×${height} chat chrome`).toEqual([]);
    const roomMenu = page.getByRole("menuitem", { name: "Room", exact: true });
    await roomMenu.click();
    expect(await page.evaluate(measureControlDensity), `${width}×${height} expanded menu`).toEqual([]);
    await page.getByRole("menu", { name: "Room", exact: true }).getByRole("menuitem", { name: "Manage agents...", exact: true }).click();
    const manager = page.getByRole("dialog", { name: "Manage room agents", exact: true });
    await expect(manager.getByText("6 active · 9 configured", { exact: true })).toBeVisible();
    await manager.getByRole("button", { name: "View Alpha configuration", exact: true }).click();
    expect(await page.evaluate(measureControlDensity), `${width}×${height} agent commands`).toEqual([]);
    const cancel = manager.getByRole("button", { name: "Cancel", exact: true });
    const normalHeight = (await cancel.boundingBox())!.height;
    await cancel.focus();
    expect((await cancel.boundingBox())!.height).toBe(normalHeight);
    expect((await manager.getByRole("button", { name: "Save roster", exact: true }).boundingBox())!.height).toBe(normalHeight);
    await cancel.click();
    await expect(manager).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

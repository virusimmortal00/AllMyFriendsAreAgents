import { expect, test } from "@playwright/test";
import { appFixtureResponse, fixtureTime } from "./app-fixtures";
import { visualRoster } from "./fixtures";
import { measureControlDensity } from "./geometry";

test("protected review initiation, stop confirmation and return controls remain reachable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let work: any[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4187") return route.abort();
    if (url.pathname === "/api/protected-work") {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        expect(body.roomId).toBe("00000000-0000-4000-8000-000000000001");
        expect(body.requestId).toBeTruthy();
        work = [{ workId: "protected-fixture", roomId: body.roomId, owner: body.owner, objective: body.objective, phase: "busy", createdAt: fixtureTime, startedAt: new Date(Date.now() - 2_000).toISOString(), stoppedAt: null, updatedAt: fixtureTime, blocker: null, disposition: null }];
        return route.fulfill({ status: 202, json: work[0] });
      }
      return route.fulfill({ json: work });
    }
    if (url.pathname.endsWith("/protected-fixture/stop")) { work[0] = { ...work[0], phase: "stopping" }; return route.fulfill({ json: work[0] }); }
    if (url.pathname.endsWith("/protected-fixture/dismiss")) { work[0] = { ...work[0], phase: "available", disposition: "no-update" }; return route.fulfill({ json: work[0] }); }
    if (url.pathname.startsWith("/api/")) {
      const result = appFixtureResponse(url.href, route.request().method(), "room-chat");
      if (result.status === 501) errors.push(`Unmocked API: ${url.pathname}`);
      return route.fulfill({ status: result.status, json: result.body });
    }
    return route.continue();
  });
  await page.goto("/tests/visual/index.html?scenario=room-chat");
  await page.getByRole("menuitem", { name: "Window", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Investigations", exact: true }).click();
  await page.getByRole("combobox", { name: "Participant", exact: true }).selectOption(visualRoster.entries[0].agentId);
  await page.getByRole("textbox", { name: "Objective", exact: true }).fill("Review navigation after reconnecting");
  await page.getByRole("button", { name: "Start protected work", exact: true }).click();
  const stop = page.getByRole("button", { name: "Stop and return to chat", exact: true });
  await expect(stop).toBeVisible(); await stop.click();
  await expect(page.getByRole("button", { name: "Stop requested…", exact: true })).toBeDisabled();
  expect(await page.evaluate(measureControlDensity)).toEqual([]);
  work[0] = { ...work[0], phase: "blocked", stoppedAt: new Date().toISOString(), blocker: "Return paused. Findings retained." };
  await expect(page.getByRole("button", { name: "Retry catch-up", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Return without an update", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry catch-up", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close Investigations and return to Chat", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

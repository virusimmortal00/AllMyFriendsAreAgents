import { expect, test } from "@playwright/test";
import { appFixtureResponse, fixtureTime } from "./app-fixtures";
import { requiredVisualFixture, visualRoster } from "./fixtures";
import { measureControlDensity } from "./geometry";

// Protected work is no longer started from a workspace (Investigations is hidden);
// work that is already running must still be stoppable from the agent's status window.
test("protected work stop confirmation and return controls remain reachable", async ({ page }, info) => {
  test.skip(info.project.use.viewport!.width <= 720, "The agent status control lives in the Who’s Here rail, which compact chat hides.");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const primaryAgent = requiredVisualFixture(visualRoster.entries[0], "protected-work owner");
  const owner = primaryAgent.agentId;
  const work: any[] = [{ workId: "protected-fixture", roomId: "00000000-0000-4000-8000-000000000001", owner, objective: "Review navigation after reconnecting", phase: "busy", createdAt: fixtureTime, startedAt: new Date(Date.parse(fixtureTime) - 2_000).toISOString(), stoppedAt: null, updatedAt: fixtureTime, blocker: null, disposition: null }];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4187") return route.abort();
    if (url.pathname === "/api/protected-work") return route.fulfill({ json: work });
    if (url.pathname.endsWith("/protected-fixture/stop")) { const record = requiredVisualFixture(work[0], "running protected work"); work[0] = { ...record, phase: "stopping" }; return route.fulfill({ json: work[0] }); }
    if (url.pathname.endsWith("/protected-fixture/dismiss")) { const record = requiredVisualFixture(work[0], "stopping protected work"); work[0] = { ...record, phase: "available", disposition: "no-update" }; return route.fulfill({ json: work[0] }); }
    if (url.pathname.startsWith("/api/")) {
      const result = appFixtureResponse(url.href, route.request().method(), "room-chat");
      if (result.status === 501) errors.push(`Unmocked API: ${url.pathname}`);
      return route.fulfill({ status: result.status, json: result.body });
    }
    return route.continue();
  });
  await page.clock.setFixedTime(new Date(fixtureTime));
  await page.goto("/tests/visual/index.html?scenario=room-chat");
  await page.getByRole("button", { name: `Open status for ${primaryAgent.conversationalName}`, exact: true }).click();
  const stop = page.getByRole("button", { name: "Stop and return to chat", exact: true });
  await expect(stop).toBeVisible(); await stop.click();
  await expect(page.getByRole("button", { name: "Stop requested…", exact: true })).toBeDisabled();
  expect(await page.evaluate(measureControlDensity)).toEqual([]);
  work[0] = { ...requiredVisualFixture(work[0], "stopped protected work"), phase: "blocked", stoppedAt: new Date().toISOString(), blocker: "Return paused. Findings retained." };
  await expect(page.getByRole("button", { name: "Retry catch-up", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Return without an update", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry catch-up", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close agent settings", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

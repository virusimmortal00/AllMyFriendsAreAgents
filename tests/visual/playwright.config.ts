import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { VISUAL_ENGINES, VISUAL_VIEWPORTS } from "./matrix";

export function visualTestPattern(scenarioIds: readonly string[]) {
  const titles = [...scenarioIds];
  if (scenarioIds.some((id) => ["room-chat", "roster-populated", "roster-detail"].includes(id))) titles.push("control density remains stable across resize boundaries and views");
  return new RegExp(`(?:^|\\s)(?:${titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`);
}

export default defineConfig({
  testDir: ".",
  testMatch: "*.visual.ts",
  ...(process.env.VISUAL_SCENARIO_IDS ? { grep: visualTestPattern(JSON.parse(process.env.VISUAL_SCENARIO_IDS)) } : {}),
  outputDir: "../../test-results/visual-runtime",
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  reporter: "list",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4187", locale: "en-US", timezoneId: "UTC", colorScheme: "light", contextOptions: { reducedMotion: "reduce" }, serviceWorkers: "block", trace: "retain-on-failure" },
  projects: VISUAL_ENGINES.flatMap((engine) => VISUAL_VIEWPORTS.map(({ id, width, height, touch }) => ({
    name: `${engine}--${id}`,
    use: { browserName: engine, viewport: { width, height }, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch,
      // Chromium's headless default hides real scrollbars from screenshots.
      // Keep them renderable so evidence reflects the product's native affordance.
      ...(engine === "chromium" ? { launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } } : {}),
    },
  }))),
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: "node node_modules/vite/bin/vite.js --config tests/visual/vite.config.ts",
    url: "http://127.0.0.1:4187/tests/visual/index.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

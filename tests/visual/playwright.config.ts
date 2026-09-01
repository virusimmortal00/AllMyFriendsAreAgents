import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { VISUAL_ENGINES, VISUAL_VIEWPORTS } from "./matrix";

export default defineConfig({
  testDir: ".",
  testMatch: "*.visual.ts",
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

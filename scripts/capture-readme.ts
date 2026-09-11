import { mkdir, copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import catalog from "../tests/visual/readme-models.json";

// Capture the real UI against the documentation-only fixture. The server has no
// live API proxy; Chromium additionally blocks every non-fixture network request.
const root = process.cwd();
const output = resolve(root, "test-results/readme");
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: resolve(root, "tests/visual/vite.config.ts"),
  server: { host: "127.0.0.1", port: 4188, strictPort: true },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await server.listen();
  browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce", serviceWorkers: "block" });
  const logos = new Map<string, Buffer>(await Promise.all(["google", "deepseek", "openai", "minimax", "openrouter"].map(async (provider) =>
    [`https://models.dev/logos/${provider}.svg`, await readFile(resolve(root, "docs/screenshots/logos", `${provider}.svg`))] as const)));
  await page.route("**/*", (route) => {
    const logo = logos.get(route.request().url());
    if (logo) return route.fulfill({ contentType: "image/svg+xml", body: logo });
    return new URL(route.request().url()).origin === "http://127.0.0.1:4188" ? route.continue() : route.abort();
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:4188/tests/visual/readme.html");
  await expect(page.getByRole("button", { name: "Manage agents...", exact: true })).toBeVisible();
  await expect(page.getByText("That resolves my concern.", { exact: false })).toBeVisible();
  for (const model of catalog.models) {
    await expect(page.getByRole("button", { name: new RegExp(`^Configure ${model.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`) })).toBeVisible();
  }
  await expect.poll(() => page.locator(".provider-mark img").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.screenshot({ path: resolve(output, "room-chat.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Manage agents...", exact: true }).click();
  await page.getByRole("button", { name: "＋ Add another agent" }).click();
  await expect(page.getByRole("searchbox", { name: "Search models or paste OpenRouter link" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Gemini 3.8 Flash.*Choose this model/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save roster", exact: true })).toBeDisabled();
  await page.screenshot({ path: resolve(output, "model-picker.png") });
  if (errors.length) throw new Error(`README fixture errors: ${errors.join("; ")}`);
  for (const name of ["room-chat.png", "model-picker.png"]) {
    await copyFile(resolve(output, name), resolve(root, "docs/screenshots", name));
  }
  console.log("Captured two README illustrations with real model identities and authored example dialogue. This is not a responsive visual-approval run.");
} finally {
  await browser?.close();
  await server.close();
}

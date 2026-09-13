import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALLER_DOWNLOADS, registerInstallerRedirects } from "./installer-redirects.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const app = express();
  registerInstallerRedirects(app);
  app.get("/{*splat}", (_request, response) => response.status(200).send("application"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("local installer redirects", () => {
  for (const [route, download] of Object.entries(INSTALLER_DOWNLOADS)) {
    it(`redirects ${route} to the latest GitHub release asset`, async () => {
      const base = await fixture();
      const response = await fetch(`${base}${route}`, { redirect: "manual" });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(download);
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
  }

  it.each(["/install.sh.backup", "/install.sh/", "/INSTALL.SH"])("leaves %s for the SPA fallback", async (path) => {
    const base = await fixture();

    const response = await fetch(`${base}${path}`, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("application");
  });
});

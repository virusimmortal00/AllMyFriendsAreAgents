import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { registerRepositoryReadiness } from "./repository-readiness.js";
import type { ProjectRepositoryConnection } from "./project-repository-connection.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
it("reports local authority loss and recovery without exposing repository information", async () => {
  const app = express();
  let valid = false;
  let disabled = false;
  registerRepositoryReadiness(app, { list: () => [{ projectId: "private-project", revision: 1, state: disabled ? "disabled" : "verified" } as ProjectRepositoryConnection] },
    () => ({ revalidateAuthority: async () => valid ? { kind: "ok", connection: {} as ProjectRepositoryConnection } : { kind: "rejected", reason: "private checkout path" } }));
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ready/repositories`;
  const failed = await fetch(url);
  expect(failed.status).toBe(503);
  expect(failed.headers.get("cache-control")).toBe("no-store");
  expect(await failed.json()).toEqual({ ready: false });
  valid = true;
  expect((await fetch(url)).status).toBe(200);
  valid = false; disabled = true;
  expect((await fetch(url)).status).toBe(200);
});

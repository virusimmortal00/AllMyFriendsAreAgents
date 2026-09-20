import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { registerRepositoryReadiness } from "./repository-readiness.js";
import type { ProjectRepositoryConnection } from "./project-repository-connection.js";
import { requiredAt } from "./test-invariants.js";

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

it("checks repositories concurrently and shares unfinished work after the response deadline", async () => {
  const app = express();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  const connections = ["first", "second"].map((projectId) => ({ projectId, revision: 1, state: "verified" } as ProjectRepositoryConnection));
  registerRepositoryReadiness(app, { list: () => connections }, (projectId) => ({
    revalidateAuthority: async () => {
      started.push(projectId);
      await gate;
      return { kind: "ok", connection: requiredAt(connections,0,"first repository connection") };
    },
  }), 50);
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ready/repositories`;
  try {
    const timedOut = await fetch(url);
    expect(timedOut.status).toBe(503);
    expect(await timedOut.json()).toEqual({ ready: false });
    expect(started).toEqual(["first", "second"]);
    expect((await fetch(url)).status).toBe(503);
    expect(started).toHaveLength(2);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await fetch(url)).status).toBe(200);
    expect(started).toEqual(["first", "second", "first", "second"]);
  } finally { release(); }
});

it("fails closed on thrown validation and permits a later successful probe", async () => {
  const app = express();
  let broken = true;
  registerRepositoryReadiness(app, { list: () => [{ projectId: "example", revision: 1, state: "verified" } as ProjectRepositoryConnection] },
    () => ({ revalidateAuthority: async () => {
      if (broken) throw new Error("private filesystem detail");
      return { kind: "ok", connection: {} as ProjectRepositoryConnection };
    } }));
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ready/repositories`;
  expect(await (await fetch(url)).json()).toEqual({ ready: false });
  broken = false;
  expect((await fetch(url)).status).toBe(200);
});

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { RoomStore } from "./room-store.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";
import { requiredAt, requiredValue } from "./test-invariants.js";

const exec = promisify(execFile);
const sourceRoot = path.resolve(import.meta.dirname, "..");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
type Tool = { url: string; token: string };
type Report = { stage: string; resumed: boolean; command: Tool; diagnostics: Tool; commandResult: { status: number; noStore: boolean }; diagnosticsResult: { status: number; noStore: boolean } };

async function eventually(check: () => boolean | Promise<boolean>, phase: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Room-tool smoke timed out: ${phase}.`);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exiting = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  try { await exiting; } finally { clearTimeout(timer); }
}

async function fixture(backend: "json" | "sqlite") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "amfaa-room-tool-smoke-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "checkout"), data = path.join(root, "data"), database = path.join(data, "room.sqlite");
  await mkdir(checkout);
  const git = (args: string[]) => exec("git", ["-C", checkout, ...args], { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  await git(["init", "-b", "main"]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--no-verify", "--allow-empty", "-m", "Fixture"]);
  const store = backend === "json" ? await RoomStore.open(checkout, data) : await SqliteRoomRepository.open(checkout, database);
  await store.updateRoster(store.snapshot().roster!.revision, [{ agentId: "codex-sol", conversationalName: "Sol", providerId: "openai", modelId: "fixture-model", enabled: true, configurationRevision: 1, commandPermissions: { allowAll: false, allowed: ["help", "task"] } }]);
  if (store instanceof SqliteRoomRepository) store.close();
  const reports: Report[] = [];
  let release = "";
  const probe = http.createServer(async (request, response) => {
    if (request.method === "POST") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      reports.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Report);
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ release }));
  });
  probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  cleanups.push(async () => { probe.closeAllConnections(); await new Promise<void>((resolve) => probe.close(() => resolve())); });
  const probeUrl = `http://127.0.0.1:${(probe.address() as net.AddressInfo).port}`;
  const binary = path.join(root, "opencode.mjs");
  await writeFile(binary, `#!${process.execPath}\n` + await readFile(path.join(sourceRoot, "server/fixtures/room-tool-smoke-opencode.mjs"), "utf8"), { mode: 0o700 });
  async function phase(value: string) { release = ""; await writeFile(path.join(root, "smoke.json"), JSON.stringify({ probe: probeUrl, phase: value })); }
  async function start() {
    const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["--import", "tsx", "--import", "./server/fixtures/server-isolation.mjs", "server/index.ts"], { cwd: sourceRoot, stdio: "ignore", env: {
      PATH: process.env.PATH, NODE_ENV: "test", AMFAA_TEST_DIRECTORY: root,
      ALL_MY_FRIENDS_ARE_AGENTS_HOST: "127.0.0.1", ALL_MY_FRIENDS_ARE_AGENTS_PORT: String(port),
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: backend, ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: data,
      ALL_MY_FRIENDS_ARE_AGENTS_SQLITE_PATH: database, ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH: checkout,
      ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR: path.join(root, "assignments"),
      ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND: binary,
    } });
    cleanups.push(() => stop(child));
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error("Isolated application exited before readiness.");
      try { return (await fetch(base + "/api/ready", { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, "application readiness");
    const joined = await fetch(base + "/api/humans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Fixture human" }) });
    expect(joined.status).toBe(201);
    const cookie = requiredAt(requiredValue(joined.headers.get("set-cookie"),"room-tool session cookie").split(";"),0,"room-tool cookie pair");
    const call = (route: string, method = "GET", body?: unknown) => fetch(base + route, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const state = async () => await (await call("/api/state")).json() as { messages: { text: string }[]; activeGenerations: Record<string, string> };
    // This route resolves live discovery/capability state before the first turn.
    expect((await call("/api/roster")).status).toBe(200);
    const task = async (name: string) => {
      await phase(name);
      const response = await call("/api/commands", "POST", { text: `/task @Sol Fixture ${name}`, clientSubmissionId: randomUUID() });
      expect(response.status).toBe(202);
    };
    const delivered = async (name: string) => {
      release = name === "retry" ? "retry-fresh" : name;
      await eventually(async () => (await state()).messages.filter(({ text }) => text === `Fixture ${name} complete.`).length === 1, `delivery ${name}`);
      await eventually(async () => Object.keys((await state()).activeGenerations).length === 0, `idle ${name}`);
    };
    return { base, call, state, task, delivered, stop: () => stop(child) };
  }
  const report = async (stage: string) => { await eventually(() => reports.some((item) => item.stage === stage), `subprocess ${stage}`); return reports.find((item) => item.stage === stage)!; };
  return { root, data, reports, start, report };
}

async function replay(report: Report, base: string) {
  const result = [];
  for (const [tool, body] of [
    [report.command, { invocation: { command: "help" }, clientSubmissionId: "smoke-child-help-0001" }],
    [report.diagnostics, { requestId: "smoke-child-diagnostics-0001", query: { window: "last-hour", scope: "self" } }],
  ] as const) {
    const response = await fetch(base + new URL(tool.url).pathname, { method: "POST", headers: { authorization: `Bearer ${tool.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    await response.arrayBuffer(); result.push(response.status);
  }
  return result;
}
function usable(report: Report, resumed: boolean) {
  // Never include opaque lease credentials in assertion failures.
  expect(report.resumed).toBe(resumed);
  expect(report.commandResult).toEqual({ status: 200, noStore: true });
  expect(report.diagnosticsResult).toEqual({ status: 200, noStore: true });
}

describe("full application room-tool smoke", () => {
  it.each(["json", "sqlite"] as const)("exercises subprocess HTTP tools, retry, cancellation, next turn, and restart on %s", async (backend) => {
    const f = await fixture(backend); let app = await f.start();
    await app.task("first"); const first = await f.report("first"); usable(first, false);
    expect(await replay(first, app.base)).toEqual([200, 200]);
    await app.delivered("first"); expect(await replay(first, app.base)).toEqual([404, 404]);

    await app.task("retry"); const resumed = await f.report("retry-resume"), fresh = await f.report("retry-fresh");
    usable(resumed, true); usable(fresh, false);
    expect(await replay(resumed, app.base)).toEqual([404, 404]);
    expect(await replay(fresh, app.base)).toEqual([200, 200]);
    await app.delivered("retry"); expect(await replay(fresh, app.base)).toEqual([404, 404]);

    await app.task("cancel"); const cancelled = await f.report("cancel"); usable(cancelled, true);
    expect((await app.call("/api/settings", "PATCH", { topic: "Fixture cancellation boundary" })).status).toBe(200);
    expect(await replay(cancelled, app.base)).toEqual([404, 404]);
    await eventually(async () => Object.keys((await app.state()).activeGenerations).length === 0, "cancelled generation cleanup");
    expect((await app.state()).messages.some(({ text }) => text === "Fixture cancel complete.")).toBe(false);

    await app.task("next"); const next = await f.report("next"); usable(next, false);
    expect(await replay(cancelled, app.base)).toEqual([404, 404]);
    await app.delivered("next"); await app.stop();
    app = await f.start(); expect(await replay(next, app.base)).toEqual([404, 404]);
    await app.task("restart"); const restarted = await f.report("restart"); usable(restarted, true);
    expect(await replay(next, app.base)).toEqual([404, 404]);
    await app.delivered("restart"); expect(await replay(restarted, app.base)).toEqual([404, 404]);
    await app.stop();

    const directory = path.join(f.data, "logs", "authoritative-v1");
    const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
    expect(files.length > 0).toBe(true);
    const logs = (await Promise.all(files.map((name) => readFile(path.join(directory, name), "utf8")))).join("\n");
    for (const { command, diagnostics } of f.reports) {
      expect([command.token, diagnostics.token, command.url, diagnostics.url].some((value) => logs.includes(value))).toBe(false);
    }
    const records = logs.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string; outcome: string; generationId?: string; attemptOrdinal?: number });
    for (const event of ["room-command-tool.lease", "room-diagnostics-tool.lease"]) {
      const accepted = records.filter((record) => record.event === event && record.outcome === "accepted");
      expect(accepted.length > 0).toBe(true);
      expect(accepted.every(({ generationId, attemptOrdinal }) => Boolean(generationId) && Number.isInteger(attemptOrdinal))).toBe(true);
      const retry = accepted.find(({ attemptOrdinal }) => attemptOrdinal === 2);
      expect(Boolean(retry)).toBe(true);
      expect(accepted.some(({ generationId, attemptOrdinal }) => generationId === retry?.generationId && attemptOrdinal === 1)).toBe(true);
      expect(JSON.stringify(accepted).includes("ses_fixture_")).toBe(false);
    }
  }, 60_000);
});

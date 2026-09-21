import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { RoomStore } from "./room-store.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";
import { requiredAt, requiredValue } from "./test-invariants.js";
const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function until(check: () => Promise<boolean>) { await expect.poll(check, { timeout: 15_000, interval: 100 }).toBe(true); }
async function fixture(backend: "json" | "sqlite", withPeer = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-protected-app-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "project"), data = path.join(root, "state"), database = path.join(data, "room.sqlite");
  await mkdir(checkout);
  const rooms = backend === "json" ? await RoomStore.open(checkout, data) : await SqliteRoomRepository.open(checkout, database);
  const roomId = rooms.roomId;
  await rooms.updateRoster(rooms.snapshot().roster!.revision, [{ agentId: "codex-sol", conversationalName: "Sol", providerId: "openai", modelId: "fixture-model", enabled: true, configurationRevision: 1, commandPermissions: { allowAll: false, allowed: ["help", "task", "pov"] } }]);
  if (withPeer) {
    const roster = rooms.snapshot().roster!;
    await rooms.updateRoster(roster.revision, [...roster.entries, { ...requiredAt(roster.entries,0,"primary protected-work agent"), agentId: "codex-terra", conversationalName: "Terra" }]);
  }
  if (rooms instanceof SqliteRoomRepository) rooms.close();
  let input: any; let workerResponse: http.ServerResponse | undefined; let termination = true;
  const reports: { returning: boolean; hasCommandTool: boolean; resumed: boolean }[] = [];
  const worker = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "DELETE") { if (termination) workerResponse?.end(); response.end(JSON.stringify({ terminated: termination })); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.url === "/probe") { reports.push(body); response.end("{}"); return; }
    input = body; workerResponse = response;
  });
  worker.listen(0, "127.0.0.1"); await once(worker, "listening");
  cleanups.push(async () => { worker.closeAllConnections(); await new Promise<void>((resolve) => worker.close(() => resolve())); });
  const workerBase = `http://127.0.0.1:${(worker.address() as net.AddressInfo).port}`;
  const binary = path.join(root, "opencode.mjs");
  await writeFile(binary, `#!${process.execPath}\n` + await readFile("server/fixtures/protected-work-opencode.mjs", "utf8"), { mode: 0o700 });
  await writeFile(path.join(root, "protected.json"), JSON.stringify({ probe: workerBase + "/probe" }));
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>((resolve) => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const env = { ALL_MY_FRIENDS_ARE_AGENTS_AGENT_CONCURRENCY: "1", PATH: process.env.PATH, NODE_ENV: "test", AMFAA_TEST_DIRECTORY: root,
    ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TEAM_JSON: JSON.stringify([{ memberId: "protected-cli", displayName: "Fixture CLI", roles: ["AUTHOR"], capabilities: ["ROOM_READ", "COMMAND_RUN"], token: "fixture-protected-cli-token-not-a-real-secret" }]),
    ALL_MY_FRIENDS_ARE_AGENTS_HOST: "127.0.0.1", ALL_MY_FRIENDS_ARE_AGENTS_PORT: String(port),
    ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: backend, ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: data,
    ALL_MY_FRIENDS_ARE_AGENTS_SQLITE_PATH: database, ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH: checkout,
    ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR: path.join(root, "assignments"), ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND: binary,
    ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATIONS_ENABLED: "true", ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATION_EXECUTOR_URL: workerBase + "/work",
  };
  const start = async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "--import", "./server/fixtures/protected-work-isolation.mjs", "server/index.ts"], { env, stdio: "ignore" });
    cleanups.push(() => stop(child));
    await until(async () => { if (child.exitCode !== null) throw new Error("Application exited before readiness"); try { return (await fetch(base + "/api/ready")).ok; } catch { return false; } });
    const joined = await fetch(base + "/api/humans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Fixture operator" }) });
    expect(joined.status).toBe(201); const cookie = requiredAt(requiredValue(joined.headers.get("set-cookie"),"protected-work session cookie").split(";"),0,"protected-work cookie pair");
    const call = (route: string, body?: unknown) => fetch(base + route, { method: body ? "POST" : "GET", headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    await call("/api/roster");
    return { child, call };
  };
  const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, ["--import", "tsx", "scripts/room-tool.ts", "work", ...args, "--room", roomId], { timeout: 10_000, env: { ...env, ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TOKEN: "fixture-protected-cli-token-not-a-real-secret" } })).stdout);
  return { start, cli, base, roomId, reports, input: () => input,
    finish: () => workerResponse!.end(JSON.stringify({ providerSessionId: "private-worker", summary: "Useful bounded finding", usage: { tokens: 1, toolCalls: 1 } })),
    termination: (value: boolean) => { termination = value; } };
}
describe.each(["json", "sqlite"] as const)("protected work through real CLI and application (%s)", (backend) => {
  it("continues to an available peer when the protected participant ranks first", async () => {
    const f = await fixture(backend, true); const app = await f.start();
    await f.cli("start", "Keep Sol protected", "--agent", "codex-sol", "--request-id", "fixture-peer-0001");
    await until(async () => Boolean(f.input()));
    const before = await (await app.call("/api/state")).json();
    const response = await app.call("/api/messages", { text: "@Sol please consider this", clientMessageId: randomUUID() });
    expect(response.status).toBe(202);
    await until(async () => {
      const state = await (await app.call("/api/state")).json();
      return state.messages.slice(before.messages.length).some((message: any) => message.speaker === "codex-terra");
    });
    const state = await (await app.call("/api/state")).json();
    expect(state.messages.slice(before.messages.length).some((message: any) => message.speaker === "codex-sol")).toBe(false);
    expect((await f.cli("list"))[0].phase).toBe("busy");
  }, 40_000);
  it("excludes ordinary dispatch, returns without a human trigger, and reopens with one acknowledged report", async () => {
    const f = await fixture(backend); const app = await f.start();
    expect((await fetch(f.base + "/api/protected-work?roomId=" + f.roomId)).status).toBe(404);
    const denied = await app.call("/api/protected-work", { roomId: "other-room", owner: "codex-sol", objective: "Cross-room", requestId: randomUUID() }); expect(denied.status).toBe(400);
    const job = await f.cli("start", "Review bounded evidence", "--agent", "codex-sol", "--request-id", "fixture-start-0001");
    await until(async () => Boolean(f.input()));
    expect(f.input().capabilities).toEqual(["READ_PROJECT", "READ_OBSERVABILITY", "RUN_READ_ONLY_TESTS"]);
    expect(f.input().excludedCapabilities).toContain("EDIT");
    expect((await app.call("/api/actions", { action: "review", target: "codex-sol" })).status).toBe(202);
    const task = await app.call("/api/commands", { text: "/task @Sol Ordinary task", clientSubmissionId: randomUUID() });
    expect(task.status).toBe(400); expect(await task.json()).toMatchObject({ result: { kind: "private-error", message: "No eligible participants are available." } });
    const pov = await app.call("/api/commands", { text: "/pov @Sol Another perspective", clientSubmissionId: randomUUID() });
    expect(pov.status).toBe(400);
    expect((await app.call("/api/messages", { text: "@Sol — your turn", clientMessageId: randomUUID() })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 350)); expect(f.reports).toHaveLength(0);
    f.finish();
    await expect.poll(async () => JSON.stringify({ work: await f.cli("list"), reports: f.reports }), { timeout: 15_000 }).toContain('"disposition":"delivered"');
    expect(f.reports).toEqual([{ returning: true, hasCommandTool: false, resumed: false }]);
    await stop(app.child); const restarted = await f.start();
    const state = await (await restarted.call("/api/state")).json();
    expect(state.messages.filter((message: any) => message.id === `command-delivery:${job.workId}:0`)).toHaveLength(1);
    expect((await f.cli("list"))[0].phase).toBe("available");
    await restarted.call("/api/actions", { action: "ask", target: "codex-sol" });
    await until(async () => f.reports.some((report) => !report.returning));
  }, 40_000);
  it("restores busy exclusion after interruption until termination is confirmed", async () => {
    const f = await fixture(backend); const app = await f.start();
    const job = await f.cli("start", "Review across restart", "--agent", "codex-sol", "--request-id", "fixture-restart-0001");
    await until(async () => Boolean(f.input()));
    f.termination(false);
    await stop(app.child);
    const restarted = await f.start();
    await until(async () => (await f.cli("list"))[0].phase === "blocked");
    expect(f.reports).toHaveLength(0);
    const task = await restarted.call("/api/commands", { text: "/task @Sol Do not interrupt recovery", clientSubmissionId: randomUUID() });
    expect(await task.json()).toMatchObject({ result: { kind: "private-error", message: "No eligible participants are available." } });
    f.termination(true);
    await f.cli("stop", "--work-id", job.workId, "--request-id", "fixture-restart-0002");
    await until(async () => (await f.cli("list"))[0].disposition === "delivered");
    expect(f.reports).toEqual([{ returning: true, hasCommandTool: false, resumed: false }]);
  }, 40_000);
  it("uses the same authenticated stop contract and waits for executor acknowledgement", async () => {
    const f = await fixture(backend); const app = await f.start();
    const job = await f.cli("start", "Review then stop", "--agent", "codex-sol", "--request-id", "fixture-stop-0001");
    await until(async () => Boolean(f.input()));
    const input = f.input();
    await fetch(input.progress.url, { method: "POST", headers: { "content-type": "application/json", authorization: input.progress.authorization }, body: JSON.stringify({ state: "WAITING_TOOL", checkpoint: { summary: "Checkpoint finding", opaqueState: "private" } }) });
    f.termination(false);
    await f.cli("stop", "--work-id", job.workId, "--request-id", "fixture-stop-0002");
    await until(async () => (await f.cli("list"))[0].phase === "blocked"); expect(f.reports).toHaveLength(0);
    f.termination(true);
    await f.cli("stop", "--work-id", job.workId, "--request-id", "fixture-stop-0003");
    await expect.poll(async () => (await f.cli("list"))[0], { timeout: 15_000 }).toMatchObject({ phase: "available" });
    expect(f.reports).toHaveLength(1);
    expect((await app.call(`/api/investigations/${job.workId}/resume`, {})).status).toBe(403);
  }, 40_000);
});

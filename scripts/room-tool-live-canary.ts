import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RoomStore } from "../server/room-store.js";

// Opt-in only: never imported by the test suite or quality gate.
assert.equal(process.env.AMFAA_CANARY_ALLOW_REAL_PROVIDER, "true", "Explicit live-provider authorization is required.");
const selection = process.env.AMFAA_CANARY_ROOM_MODEL || "";
assert(selection.startsWith("openrouter/"), "Set AMFAA_CANARY_ROOM_MODEL to an authenticated openrouter/<model> selection.");
const command = process.env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND || "opencode";
const exec = promisify(execFile);
const source = process.cwd();
const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-live-room-tools-"));
await chmod(root, 0o700);
const checkout = path.join(root, "project"), data = path.join(root, "room");
const xdg = path.join(root, "xdg");
const evidencePath = path.join(root, "cli-evidence.jsonl");
let child: ChildProcess | undefined;
const interrupted = new AbortController();
const onInterrupt = () => interrupted.abort();
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onInterrupt);
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exiting = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child?.kill("SIGKILL"), 3_000);
  try { await exiting; } finally { clearTimeout(timer); }
}
async function until(check: () => Promise<boolean>, label: string, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    interrupted.signal.throwIfAborted();
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${label}`);
}
async function records() {
  const directory = path.join(data, "logs", "authoritative-v1");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  return (await Promise.all(files.map((name) => readFile(path.join(directory, name), "utf8"))))
    .join("\n").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
async function start() {
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "--import", "./server/fixtures/server-isolation.mjs", "--import", "./server/fixtures/live-tool-observer.mjs", "server/index.ts"], {
    cwd: source, stdio: "ignore", env: {
      PATH: process.env.PATH, HOME: root, NODE_ENV: "test", AMFAA_TEST_DIRECTORY: root,
      AMFAA_LIVE_EVIDENCE: evidencePath,
      XDG_DATA_HOME: xdg, XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      ALL_MY_FRIENDS_ARE_AGENTS_HOST: "127.0.0.1", ALL_MY_FRIENDS_ARE_AGENTS_PORT: String(port),
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "json", ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: data,
      ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH: checkout,
      ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR: path.join(root, "assignments"),
      ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND: command,
    },
  });
  await until(async () => {
    if (child?.exitCode !== null) throw new Error("Isolated room process exited.");
    try { return (await fetch(base + "/api/ready", { signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(500)]) })).ok; } catch { return false; }
  }, "readiness", 30_000);
  const joined = await fetch(base + "/api/humans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Live smoke operator" }), signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(10_000)]) });
  assert.equal(joined.status, 201);
  const cookie = joined.headers.get("set-cookie")!.split(";")[0];
  const call = (route: string, body?: unknown) => fetch(base + route, {
    method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(10_000)]),
  });
  const roster = await call("/api/roster");
  assert.equal(roster.status, 200);
  const availability = (await roster.json()).participantAvailability?.["codex-sol"];
  assert.equal(availability?.available, true, `Live model preflight: ${availability?.reason || "unknown"}`);
  return call;
}
try {
  const version = (await exec(command, ["--version"], { signal: interrupted.signal, timeout: 10_000 })).stdout.trim();
  assert.equal(version, "1.18.25", "This canary targets the audited stock CLI lane.");
  await mkdir(checkout);
  await mkdir(path.join(xdg, "opencode"), { recursive: true, mode: 0o700 });
  // OpenCode's credential store remains private and is deleted with the fixture.
  const auth = path.join(xdg, "opencode", "auth.json");
  await copyFile(path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "opencode/auth.json"), auth);
  await chmod(auth, 0o600);
  const git = (args: string[]) => exec("git", ["-C", checkout, ...args], { signal: interrupted.signal, timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  await git(["init", "-b", "main"]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Fixture"]);
  const store = await RoomStore.open(checkout, data);
  await store.updateRoster(store.snapshot().roster!.revision, [{ agentId: "codex-sol", conversationalName: "Sol", providerId: "openrouter", modelId: selection.slice("openrouter/".length), enabled: true, configurationRevision: 1, commandPermissions: { allowAll: false, allowed: ["help"] } }]);
  const generations: string[] = [];
  for (const phase of ["first", "restart"] as const) {
    const call = await start();
    const before = (await records()).filter((record) => record.event === "agent.generation.started").length;
    const marker = `LIVE_SMOKE_${phase.toUpperCase()}_OK`;
    const response = await call("/api/commands", { text: `/task @Sol Read-only smoke test. Call room_command with input command help once, then room_diagnostics with scope self and window last-hour once. Use only these two tools; do not read project files, use network tools, or mutate anything. After both succeed include ${marker} in a brief reply. Do not include tool output or diagnostic evidence in the reply.`, clientSubmissionId: randomUUID() });
    assert.equal(response.status, 202);
    await until(async () => {
      const events = await records();
      const starts = events.filter((record) => record.event === "agent.generation.started");
      if (starts.length <= before) return false;
      const current = starts.at(-1)!;
      const failed = events.some((record) => record.generationId === current.generationId && /failed|error/.test(record.event || ""));
      assert.equal(failed, false, "Live generation failed; raw diagnostics are intentionally withheld.");
      const state = await (await call("/api/state")).json();
      const messages = state.messages.filter((message: { speaker: string }) => message.speaker === "codex-sol");
      const delivered = messages.some((message: { text: string }) => message.text.includes(marker));
      if (Object.keys(state.activeGenerations).length === 0 && messages.length && !delivered) {
        console.log(JSON.stringify({ phase, messages: messages.map((message: { text: string }) => ({ length: message.text.length, containsMarker: message.text.includes(marker) })) }));
        assert.fail("Agent delivered a response without the completion marker.");
      }
      return Object.keys(state.activeGenerations).length === 0 && delivered;
    }, `${phase} live tools and delivery`);
    await stop();
    const events = await records();
    const started = events.filter((record) => record.event === "agent.generation.started").at(-1)!;
    assert.equal(started.resumedSession, phase === "restart");
    generations.push(started.generationId);
    for (const event of ["room-command-tool.lease", "room-diagnostics-tool.lease"]) {
      const relevant = events.filter((record) => record.event === event && record.generationId === started.generationId);
      const accepted = relevant.some((record) => record.outcome === "accepted" && record.attemptOrdinal === 1);
      if (!accepted) console.log(JSON.stringify({ phase, event, leases: relevant.map(({ outcome, reason, attemptOrdinal }) => ({ outcome, reason, attemptOrdinal })), completed: events.filter((record) => record.event === "agent.generation.completed" && record.generationId === started.generationId).map(({ toolCalls, toolFailures }) => ({ toolCalls, toolFailures })) }));
      assert(accepted, `${phase}: actual ${event} execution was not observed`);
    }
    assert.equal((await git(["status", "--porcelain", "--untracked-files=all"])).stdout, "", "Fixture project changed.");
    console.log(`PASS ${phase}: both live tools accepted, reply delivered, resumed=${phase === "restart"}, project unchanged`);
  }
  assert.notEqual(generations[0], generations[1]);
  console.log(`PASS OpenCode ${version}, ${selection}: fresh generation leases across application restart`);
} catch (error) {
  console.log(await readFile(evidencePath, "utf8").catch(() => "No CLI evidence."));
  // Keep evidence useful on failures without retaining prompts or provider output.
  const events = await records().catch(() => []);
  console.log(JSON.stringify({ status: "failed", generations: events.filter((record) => record.event === "agent.generation.started").length,
    completions: events.filter((record) => record.event === "agent.generation.completed").map(({ toolCalls, toolFailures }) => ({ toolCalls, toolFailures })),
    leases: events.filter((record) => ["room-command-tool.lease", "room-diagnostics-tool.lease"].includes(record.event)).map(({ event, outcome, reason, attemptOrdinal }) => ({ event, outcome, reason, attemptOrdinal })),
  }));
  throw error;
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onInterrupt);
}

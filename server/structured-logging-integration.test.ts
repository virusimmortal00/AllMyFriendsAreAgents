import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const resources: Array<{ child?: ChildProcess; directory?: string }> = [];
afterEach(async () => Promise.all(resources.splice(0).map(async ({ child, directory }) => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try { await stopped; } finally { clearTimeout(timer); }
  }
  if (directory) await rm(directory, { recursive: true, force: true });
})));

async function port() { const server = net.createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const value = (server.address() as net.AddressInfo).port; await new Promise<void>((resolve) => server.close(() => resolve())); return value; }

describe("server structured logging facade", () => {
  it("emits startup, HTTP, storage/migration, GitHub, manifest, lease, tool-policy, and shutdown events without agent invocation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-structured-integration-")); const listenPort = await port();
    const project = path.join(directory, "project");
    await mkdir(project);
    const child = spawn(process.execPath, ["--import", "tsx", "--import", "./server/fixtures/server-isolation.mjs", "server/index.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        PATH: process.env.PATH, NODE_ENV: "test", AMFAA_TEST_DIRECTORY: directory,
        ALL_MY_FRIENDS_ARE_AGENTS_HOST: "127.0.0.1", ALL_MY_FRIENDS_ARE_AGENTS_PORT: String(listenPort),
        ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: path.join(directory, "data"), ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "json",
        ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH: project, ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR: path.join(directory, "worktrees"),
        ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND: path.join(directory, "missing-opencode"),
      }, stdio: ["ignore", "ignore", "pipe"],
    });
    resources.push({ child, directory }); const base = `http://127.0.0.1:${listenPort}`;
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4_000); });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Logging fixture exited before readiness (${child.exitCode}): ${stderr}`);
      try { if ((await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await fetch(`${base}/api/ready`)).ok).toBe(true);
    child.kill("SIGTERM"); await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("server did not stop")), 5_000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
    const logDirectory = path.join(directory, "data", "logs", "authoritative-v1");
    const logFiles = (await readdir(logDirectory)).filter((name) => name.endsWith(".jsonl"));
    const contents = await Promise.all(logFiles.map((name) => readFile(path.join(logDirectory, name), "utf8")));
    const records = contents.flatMap((content) => content.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line))); const events = records.map((record) => record.event);
    for (const record of records) {
      expect(record).toMatchObject({ envelopeVersion: 1, stream: expect.stringMatching(/^(server-service-lifecycle|opencode-harness|openrouter-provider|generations|capability-decisions|security-audit)$/), schemaVersion: 1, service: "all-my-friends-are-agents", serviceVersion: "0.1.0", instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/), correlationId: expect.any(String), agentId: null, environment: expect.any(String) });
      expect(Object.hasOwn(record, "outcome") && Object.hasOwn(record, "reason")).toBe(true);
    }
    expect(records.every((record) => Object.hasOwn(record, "deploymentCommit") && Object.hasOwn(record, "deploymentEpoch"))).toBe(true);
    expect(events).toEqual(expect.arrayContaining(["server.startup.started", "storage.configuration.resolved", "storage.migration.checked", "github.store.initialized", "github.adapter.policy", "github.read-cache.snapshot", "assignment.lifecycle.reconcile.started", "assignment.lifecycle.reconcile.completed", "assignment.manifest.snapshot", "assignment.lease.snapshot", "agent.tool-policy.snapshot", "server.startup.completed", "http.request.completed", "server.shutdown.started", "server.shutdown.completed"]));
    const owners = new Map<string, Set<string>>();
    for (const record of records) { const streams = owners.get(record.event) || new Set<string>(); streams.add(record.stream); owners.set(record.event, streams); }
    expect([...owners.values()].every((streams) => streams.size === 1)).toBe(true);
  }, 20_000);
});

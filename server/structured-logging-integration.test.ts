import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const resources: Array<{ child?: ChildProcess; directory?: string }> = [];
afterEach(async () => Promise.all(resources.splice(0).map(async ({ child, directory }) => { if (child?.exitCode === null) child.kill("SIGKILL"); if (directory) await rm(directory, { recursive: true, force: true }); })));

async function port() { const server = net.createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const value = (server.address() as net.AddressInfo).port; await new Promise<void>((resolve) => server.close(() => resolve())); return value; }

describe("server structured logging facade", () => {
  it("emits startup, HTTP, storage/migration, GitHub, manifest, lease, tool-policy, and shutdown events without agent invocation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-structured-integration-")); const listenPort = await port();
    const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, ALL_MY_FRIENDS_ARE_AGENTS_PORT: String(listenPort), ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: directory, ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "json", ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND: path.join(directory, "missing-opencode") }, stdio: ["ignore", "pipe", "pipe"] });
    resources.push({ child, directory }); const base = `http://127.0.0.1:${listenPort}`;
    for (let attempt = 0; attempt < 120; attempt++) { try { if ((await fetch(`${base}/api/ready`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 25)); }
    expect((await fetch(`${base}/api/ready`)).ok).toBe(true);
    child.kill("SIGTERM"); await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("server did not stop")), 5_000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
    const records = (await readFile(path.join(directory, "server.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)); const events = records.map((record) => record.event);
    for (const record of records) expect(record).toMatchObject({ schemaVersion: 1, service: "all-my-friends-are-agents", serviceVersion: "0.1.0", instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/), environment: expect.any(String) });
    expect(records.every((record) => Object.hasOwn(record, "deploymentCommit") && Object.hasOwn(record, "deploymentEpoch"))).toBe(true);
    expect(events).toEqual(expect.arrayContaining(["server.startup.started", "storage.configuration.resolved", "storage.migration.checked", "github.store.initialized", "github.adapter.policy", "github.read-cache.snapshot", "assignment.lifecycle.reconcile.started", "assignment.lifecycle.reconcile.completed", "assignment.manifest.snapshot", "assignment.lease.snapshot", "agent.tool-policy.snapshot", "server.startup.completed", "http.request.completed", "server.shutdown.started", "server.shutdown.completed"]));
  }, 10_000);
});

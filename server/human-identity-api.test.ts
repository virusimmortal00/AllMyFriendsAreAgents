import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const resources: Array<{ child?: ChildProcess; directory?: string }> = [];
const ISOLATED_SERVER_READY_TIMEOUT_MS = 10_000;
const ISOLATED_SERVER_TEST_TIMEOUT_MS = 15_000;

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async ({ child, directory }) => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try { await stopped; } finally { clearTimeout(timer); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }));
});

async function availablePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function serverFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-identity-api-"));
  const project = path.join(directory, "project");
  await mkdir(project);
  const port = await availablePort();
  const child = spawn(process.execPath, ["--import", "tsx", "--import", "./server/fixtures/server-isolation.mjs", "server/index.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      AMFAA_TEST_DIRECTORY: directory,
      ALL_MY_FRIENDS_ARE_AGENTS_HOST: "127.0.0.1",
      ALL_MY_FRIENDS_ARE_AGENTS_PORT: String(port),
      ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: path.join(directory, "data"),
      ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH: project,
      ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR: path.join(directory, "worktrees"),
      ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND: path.join(directory, "missing-opencode"),
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "json",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  resources.push({ child, directory });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  const readyDeadline = Date.now() + ISOLATED_SERVER_READY_TIMEOUT_MS;
  while (Date.now() < readyDeadline) {
    if (child.exitCode !== null) throw new Error(`Identity test server exited early (${child.exitCode}): ${stderr}`);
    try {
      if ((await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(500) })).ok) return { base };
    } catch {
      // The isolated server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Identity test server did not become ready: ${stderr}`);
}

function cookie(response: Response) {
  return response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function jsonCall(base: string, route: string, init: RequestInit = {}, session = "") {
  return fetch(`${base}${route}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Cookie: session } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

describe("adversarial human identity API", () => {
  it("rejects unauthenticated room mutations before trusting any supplied identity", { timeout: ISOLATED_SERVER_TEST_TIMEOUT_MS }, async () => {
    const { base } = await serverFixture();
    const spoof = { humanId: "public-victim-id", actorId: "public-victim-id" };
    const attempts: Array<[string, string, Record<string, unknown>]> = [
      ["PATCH", "/api/style", { ...spoof, style: { textColor: "#ec301a" } }],
      ["PATCH", "/api/avatar", { ...spoof, avatarUrl: null }],
      ["POST", "/api/messages", { ...spoof, text: "", clientMessageId: "message_123" }],
      ["PATCH", "/api/settings", { ...spoof, roomName: "Hostile rename" }],
      ["POST", "/api/actions", { ...spoof, action: "ask", target: "codex-sol" }],
      ["POST", "/api/heartbeat/authorize", { ...spoof, expectedRevision: 1, reason: "spoof" }],
      ["POST", "/api/heartbeat/emergency-stop", { ...spoof, expectedRevision: 1, reason: "spoof" }],
    ];

    for (const [method, route, body] of attempts) {
      const response = await jsonCall(base, route, { method, body: JSON.stringify(body) });
      expect(response.status, `${method} ${route}`).toBe(401);
    }
    const malformed = await jsonCall(base, "/api/style", { method: "PATCH", body: JSON.stringify({ humanId: "public-victim-id", style: {} }) }, "amfaa_human_session=%E0%A4%A");
    expect(malformed.status).toBe(401);
    const state = await (await jsonCall(base, "/api/state")).json() as { settings: { roomName: string } };
    expect(state.settings.roomName).not.toBe("Hostile rename");
  });

  it("isolates two sessions even when IDs, names, and styles are supplied adversarially", { timeout: ISOLATED_SERVER_TEST_TIMEOUT_MS }, async () => {
    const { base } = await serverFixture();
    const victimJoin = await jsonCall(base, "/api/humans", { method: "POST", body: JSON.stringify({ name: "Alex", style: { textColor: "#3074fd" } }) });
    const victim = await victimJoin.json() as { id: string; style: { textColor: string } };
    const victimCookie = cookie(victimJoin);
    expect(victimJoin.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");

    const attackerJoin = await jsonCall(base, "/api/humans", { method: "POST", body: JSON.stringify({ id: victim.id, humanId: victim.id, name: "Alex", style: { textColor: "#ec301a" } }) });
    const attacker = await attackerJoin.json() as { id: string; style: { textColor: string } };
    const attackerCookie = cookie(attackerJoin);
    expect(attacker.id).not.toBe(victim.id);
    expect(attackerCookie).not.toBe(victimCookie);

    const attack = await jsonCall(base, "/api/style", {
      method: "PATCH",
      body: JSON.stringify({ id: victim.id, humanId: victim.id, actorId: victim.id, style: { textColor: "#fefe1e" } }),
    }, attackerCookie);
    expect(attack.status).toBe(200);
    expect((await attack.json() as { id: string; style: { textColor: string } })).toMatchObject({ id: attacker.id, style: { textColor: "#fefe1e" } });

    const avatarUrl = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64")}`;
    const avatarAttack = await jsonCall(base, "/api/avatar", {
      method: "PATCH",
      body: JSON.stringify({ id: victim.id, humanId: victim.id, actorId: victim.id, avatarUrl }),
    }, attackerCookie);
    expect(avatarAttack.status).toBe(200);
    expect(await avatarAttack.json()).toMatchObject({ id: attacker.id, avatarUrl });

    const permissionAttack = await jsonCall(base, "/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ actorId: victim.id, humanId: victim.id, writableAgent: "codex-sol" }),
    }, attackerCookie);
    expect(permissionAttack.status).toBe(400);
    expect(await permissionAttack.json()).toEqual({ error: "Room participants are read-only. Source changes require an explicit governed implementation handoff." });
    const room = await (await jsonCall(base, "/api/state")).json() as { messages: Array<{ humanId?: string; kind?: string }> };
    expect(room.messages.findLast(({ kind }) => kind === "status")?.humanId).not.toBe(attacker.id);

    const victimResume = await jsonCall(base, "/api/humans", {
      method: "POST",
      body: JSON.stringify({ id: attacker.id, name: "Alex", style: victim.style }),
    }, victimCookie);
    const resumedVictim = await victimResume.json();
    expect(resumedVictim).toMatchObject({ id: victim.id, style: { textColor: "#3074fd" } });
    expect(resumedVictim).not.toHaveProperty("avatarUrl");
  });
});

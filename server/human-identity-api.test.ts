import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const resources: Array<{ child?: ChildProcess; directory?: string }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async ({ child, directory }) => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
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
  const port = await availablePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      ALL_MY_FRIENDS_ARE_AGENTS_PORT: String(port),
      ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: directory,
      ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "json",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  resources.push({ child, directory });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Identity test server exited early (${child.exitCode}): ${stderr}`);
    try {
      if ((await fetch(`${base}/api/ready`)).ok) return { base };
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
  it("rejects unauthenticated room mutations before trusting any supplied identity", async () => {
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

  it("isolates two sessions even when IDs, names, and styles are supplied adversarially", async () => {
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
    expect(permissionAttack.status).toBe(401);
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

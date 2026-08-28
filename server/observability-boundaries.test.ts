import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOM_COMMANDS, COMMAND_CATALOG_REVISION, type RoomCommandName } from "../shared/command-domain.js";
import { CommandRuntime } from "./command-runtime.js";
import { GitHubReadAdapter } from "./github-read-adapter.js";
import { GitHubReadService } from "./github-read-service.js";
import { GitHubReadStore } from "./github-read-store.js";
import { RoomStore } from "./room-store.js";

const roots: string[] = [];
const runtimes: CommandRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function runtime(fetcher: typeof fetch, ceiling: readonly RoomCommandName[] = ROOM_COMMANDS) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-observability-boundary-")); roots.push(root);
  const store = await RoomStore.open(root, path.join(root, "state"));
  await store.updateRoster(1, store.snapshot().roster!.entries.map((entry) => entry.agentId === "codex-sol" ? { ...entry, commandPermissions: { allowAll: false, allowed: [...ROOM_COMMANDS], catalogRevision: COMMAND_CATALOG_REVISION } } : entry));
  const outcomes: string[] = [];
  const githubRead = new GitHubReadService(new GitHubReadStore(new GitHubReadAdapter({ owner: "owner", repository: "repo", defaultBranch: "main", token: "dedicated-read-token" }, fetcher)), "owner/repo");
  const instance = new CommandRuntime({ store, ceiling, roster: () => store.snapshot().roster!, canLaunch: () => true, executeTask: async () => ({}), executePov: async () => ({}), deliverPov: async () => undefined, deliverTask: async () => undefined, publishStatus: async () => { throw new Error("publication unavailable"); }, publishGhResult: async () => undefined, githubRead, capabilityAudit: async (event) => { outcomes.push(event.outcome); throw new Error(`audit-${event.outcome}`); }, operationLog: () => { throw new Error("operation logger unavailable"); } });
  runtimes.push(instance);
  return { instance, outcomes };
}

describe("best-effort command observability", () => {
  it("keeps attempted, allowed, completed, failed, and denied audit rejection from changing /gh results", async () => {
    const ok = await runtime(async () => new Response(JSON.stringify([{ number: 1, title: "Read only", state: "open", draft: false, user: { login: "a" }, updated_at: "2026-08-27T00:00:00Z", base: { ref: "main" }, head: { ref: "branch", sha: "a".repeat(40) }, body: "safe" }]), { status: 200 }));
    await expect(ok.instance.submit({ command: "gh", selector: { kind: "recent" } }, { kind: "agent", id: "codex-sol", displayName: "Sol" }, "audit-completed-01")).resolves.toMatchObject({ kind: "accepted" });
    expect(ok.outcomes).toEqual(expect.arrayContaining(["attempted", "allowed", "completed"]));

    const failed = await runtime(async () => new Response("missing", { status: 404 }));
    await expect(failed.instance.submit({ command: "gh", selector: { kind: "recent" } }, { kind: "agent", id: "codex-sol", displayName: "Sol" }, "audit-failed-0001")).resolves.toMatchObject({ kind: "accepted" });
    expect(failed.outcomes).toEqual(expect.arrayContaining(["attempted", "allowed", "failed"]));

    const denied = await runtime(async () => new Response("unused"), ["help"]);
    await expect(denied.instance.submit({ command: "gh", selector: { kind: "recent" } }, { kind: "agent", id: "codex-sol", displayName: "Sol" }, "audit-denied-0001")).resolves.toMatchObject({ kind: "private-error" });
    expect(denied.outcomes).toEqual(expect.arrayContaining(["attempted", "denied"]));
  });
});

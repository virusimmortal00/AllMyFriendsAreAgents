import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityAuditStore } from "./capability-audit.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("capability audit", () => {
  it("bounds retention and excludes sensitive input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-cap-audit-")); roots.push(root);
    const store = await CapabilityAuditStore.open(root, 10);
    for (let index = 0; index < 14; index++) await store.append({ agentId: "codex-sol", capability: "github_read", outcome: index % 2 ? "allowed" : "attempted", correlationId: `request-${index}`, reason: `authorization=Bearer very-secret-token-${index}` });
    expect(store.list(100)).toHaveLength(10);
    const raw = await readFile(store.filePath, "utf8");
    expect(raw).not.toContain("very-secret-token");
    expect(raw).toContain("[REDACTED]");
  });

  it("recovers later persistence after one queued write fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-cap-audit-recovery-")); roots.push(root);
    const store = await CapabilityAuditStore.open(root, 10);
    await mkdir(store.filePath);
    await expect(store.append({ agentId: "codex-sol", capability: "github_read", outcome: "failed" })).rejects.toBeDefined();
    await rm(store.filePath, { recursive: true });
    await expect(store.append({ agentId: "codex-sol", capability: "github_read", outcome: "completed" })).resolves.toBeDefined();
    const reopened = await CapabilityAuditStore.open(root, 10);
    expect(reopened.list()).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "completed" })]));
  });
});

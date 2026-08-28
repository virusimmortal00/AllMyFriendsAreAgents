import { mkdtemp, readFile, rm } from "node:fs/promises";
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
});

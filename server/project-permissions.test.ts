import { describe, expect, it } from "vitest";
import { projectPermissionAuditMessages } from "./project-permissions.js";

const alice = { id: "alice-id", name: "Alice" };

describe("project permission audit messages", () => {
  it("records attributed grants and revocations", () => {
    expect(projectPermissionAuditMessages("nobody", "cursor-grok", alice)).toEqual([
      "Alice granted project write access to Cursor [Grok 4.6].",
    ]);
    expect(projectPermissionAuditMessages("cursor-grok", "nobody", alice)).toEqual([
      "Alice revoked project write access from Cursor [Grok 4.6].",
    ]);
  });

  it("records both sides of a single-writer replacement", () => {
    expect(projectPermissionAuditMessages("codex-sol", "cursor-gemini", alice)).toEqual([
      "Alice revoked project write access from Codex [gpt-5.6 Sol].",
      "Alice granted project write access to Cursor [Gemini 3.1 Pro].",
    ]);
  });

  it("does not manufacture an event when the setting is unchanged", () => {
    expect(projectPermissionAuditMessages("cursor-grok", "cursor-grok", alice)).toEqual([]);
  });
});

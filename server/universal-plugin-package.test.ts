import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PLUGIN_NAME = "all-my-friends-are-agents";
const VERSION = "0.1.0";
const LOCAL_MCP_URL = "http://127.0.0.1:53147/mcp";
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", PLUGIN_NAME);

function json(relativePath: string): Record<string, any> {
  return JSON.parse(readFileSync(join(pluginRoot, relativePath), "utf8"));
}

function text(relativePath: string): string {
  return readFileSync(join(pluginRoot, relativePath), "utf8");
}

describe("universal plugin package", () => {
  it("keeps one identity and version across portable and client manifests", () => {
    const manifests = [
      json("plugin.json"),
      json(".codex-plugin/plugin.json"),
      json(".cursor-plugin/plugin.json"),
      json("adapters/claude-code/.claude-plugin/plugin.json"),
    ];

    for (const manifest of manifests) {
      expect(manifest.name).toBe(PLUGIN_NAME);
      expect(manifest.version).toBe(VERSION);
    }
  });

  it("points every client adapter at the same MCP endpoint", () => {
    const portable = json("mcp.json").mcpServers[PLUGIN_NAME];
    const codex = json(".mcp.json").mcpServers[PLUGIN_NAME];
    const cursor = json("cursor.mcp.json").mcpServers[PLUGIN_NAME];
    const claude = json("adapters/claude-code/.mcp.json").mcpServers[PLUGIN_NAME];
    const opencode = json("adapters/opencode/opencode.json").mcp[PLUGIN_NAME];

    expect([portable.url, codex.url, cursor.url, claude.url, opencode.url]).toEqual(
      Array(5).fill(LOCAL_MCP_URL),
    );
    expect(portable.type).toBe("streamable-http");
    expect(codex.type).toBe("http");
    expect(claude.type).toBe("http");
    expect(opencode.type).toBe("remote");
  });

  it("keeps the portable core credential-neutral and adapters secret-safe", () => {
    const portable = json("mcp.json").mcpServers[PLUGIN_NAME];
    const codex = json(".mcp.json").mcpServers[PLUGIN_NAME];
    const cursor = json("cursor.mcp.json").mcpServers[PLUGIN_NAME];
    const claude = json("adapters/claude-code/.mcp.json").mcpServers[PLUGIN_NAME];
    const opencode = json("adapters/opencode/opencode.json").mcp[PLUGIN_NAME];

    expect(portable.headers).toBeUndefined();
    expect(portable.bearer_token_env_var).toBeUndefined();
    expect(codex.bearer_token_env_var).toBe("AMFAA_ROOM_AUTH");
    expect(cursor.headers.Authorization).toBe("Bearer ${AMFAA_ROOM_AUTH}");
    expect(claude.headers.Authorization).toBe("Bearer ${AMFAA_ROOM_AUTH}");
    expect(opencode.headers.Authorization).toBe("Bearer {env:AMFAA_ROOM_AUTH}");

    const serializedAdapters = JSON.stringify({ codex, cursor, claude, opencode });
    expect(serializedAdapters).not.toMatch(/Bearer [A-Za-z0-9_-]{24,}/);
  });

  it("ships one canonical consultation contract through four discovery adapters", () => {
    const canonicalPath = "skills/room-consultation/SKILL.md";
    const canonical = text(canonicalPath);
    const adapters = [
      "adapters/codex/skills/room-consultation/SKILL.md",
      "adapters/claude-code/skills/room-consultation/SKILL.md",
      "adapters/cursor/skills/room-consultation/SKILL.md",
      "adapters/opencode/skills/room-consultation/SKILL.md",
    ];

    expect(canonical).toMatch(/^---\nname: room-consultation\n/m);
    for (const tool of ["list_rooms", "start_room_consultation", "get_room_consultation", "respond_to_room_consultation", "cancel_room_consultation"]) {
      expect(canonical).toContain(`\`${tool}\``);
    }
    for (const requirement of ["handoff", "active participation", "room_id", "consultation_id", "idempotency_key", "input_required", "final_artifact", "dissent", "uncertainty"]) {
      expect(canonical).toContain(requirement);
    }

    for (const path of adapters) {
      const adapter = text(path);
      expect(adapter).toContain("../../../../skills/room-consultation/SKILL.md");
      expect(adapter).not.toContain("## Procedure");
      expect(adapter).not.toContain("start_room_consultation");
    }
  });

  it("documents portable consultation limits without leaking credential material", () => {
    const readme = text("README.md");
    expect(readme).toContain("multi-room");
    expect(readme).toContain("handoff");
    expect(readme).toContain("not a credential-transfer mechanism");
    expect(readme).toContain("Remote releases");
    expect(readme).toContain("AMFAA_ROOM_AUTH");
    expect(readme).not.toMatch(/Bearer [A-Za-z0-9_-]{24,}/);
    expect(readme).not.toMatch(/AMFAA_ROOM_AUTH=[A-Za-z0-9_-]{24,}/);
  });
});

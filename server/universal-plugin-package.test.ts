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
});

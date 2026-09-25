import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCodeAuthFilePath, readOpenRouterApiKey } from "./openrouter-credentials.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function withAuthFile(content: unknown) {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "amfaa-opencode-data-"));
  temporaryDirectories.push(dataHome);
  await mkdir(path.join(dataHome, "opencode"), { recursive: true });
  if (content !== undefined) await writeFile(path.join(dataHome, "opencode", "auth.json"), typeof content === "string" ? content : JSON.stringify(content));
  return { XDG_DATA_HOME: dataHome } as NodeJS.ProcessEnv;
}

describe("openCodeAuthFilePath", () => {
  it("prefers XDG_DATA_HOME and falls back to ~/.local/share", () => {
    expect(openCodeAuthFilePath({ XDG_DATA_HOME: "/custom/data" } as NodeJS.ProcessEnv)).toBe(path.join("/custom/data", "opencode", "auth.json"));
    expect(openCodeAuthFilePath({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), ".local", "share", "opencode", "auth.json"));
  });
});

describe("readOpenRouterApiKey", () => {
  it("prefers a valid launch-time key over OpenCode's stored key", async () => {
    const env = await withAuthFile({ openrouter: { type: "api", key: "sk-or-v1-stored-fixture-key" } });
    env.OPENROUTER_API_KEY = "sk-or-v1-launch-fixture-key";
    await expect(readOpenRouterApiKey(env)).resolves.toBe("sk-or-v1-launch-fixture-key");
  });

  it("uses a valid launch-time key when no OpenCode auth file exists", async () => {
    const env = await withAuthFile(undefined);
    env.OPENROUTER_API_KEY = "sk-or-v1-launch-fixture-key";
    await expect(readOpenRouterApiKey(env)).resolves.toBe("sk-or-v1-launch-fixture-key");
  });

  it.each([
    "",
    "short",
    " sk-or-v1-launch-fixture-key",
    "sk-or-v1-launch-fixture-key\n",
    "sk-or-v1-launch-fixture-key:",
    "a".repeat(301),
  ])("ignores an invalid launch-time key and falls back to OpenCode's stored key (%j)", async (invalidKey) => {
    const env = await withAuthFile({ openrouter: { type: "api", key: "sk-or-v1-stored-fixture-key" } });
    env.OPENROUTER_API_KEY = invalidKey;
    await expect(readOpenRouterApiKey(env)).resolves.toBe("sk-or-v1-stored-fixture-key");
  });

  it("returns no credential without exposing an invalid launch-time value when the file is absent", async () => {
    const env = await withAuthFile(undefined);
    env.OPENROUTER_API_KEY = "invalid private value";
    await expect(readOpenRouterApiKey(env)).resolves.toBeUndefined();
  });

  it("reads the key OpenCode stores for an API-key connection", async () => {
    const env = await withAuthFile({ openrouter: { type: "api", key: "sk-or-v1-fixture-not-a-real-key" } });
    await expect(readOpenRouterApiKey(env)).resolves.toBe("sk-or-v1-fixture-not-a-real-key");
  });

  it("returns undefined when no OpenRouter entry, no file, or the shape is unexpected", async () => {
    await expect(readOpenRouterApiKey(await withAuthFile({ anthropic: { type: "api", key: "unrelated" } }))).resolves.toBeUndefined();
    await expect(readOpenRouterApiKey(await withAuthFile(undefined))).resolves.toBeUndefined();
    await expect(readOpenRouterApiKey(await withAuthFile("not json"))).resolves.toBeUndefined();
    await expect(readOpenRouterApiKey(await withAuthFile({ openrouter: { type: "oauth" } }))).resolves.toBeUndefined();
    await expect(readOpenRouterApiKey(await withAuthFile({ openrouter: { type: "api", key: "short" } }))).resolves.toBeUndefined();
  });
});

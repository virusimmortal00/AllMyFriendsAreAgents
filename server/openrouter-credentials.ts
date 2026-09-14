import { constants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_AUTH_FILE_BYTES = 64 * 1024;
const KEY_PATTERN = /^[A-Za-z0-9._-]{10,300}$/;

/**
 * The credential file OpenCode itself reads before talking to a provider. Same trust boundary as
 * running `opencode`: this process already shells out to that binary, which reads this exact file.
 */
export function openCodeAuthFilePath(env: NodeJS.ProcessEnv = process.env) {
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "auth.json");
}

/** Reads the OpenRouter credential OpenCode stores after either an API-key paste or its OAuth flow. */
export async function readOpenRouterApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(openCodeAuthFilePath(env), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_AUTH_FILE_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    await handle.read(buffer, 0, stat.size, 0);
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const entry = (parsed as Record<string, unknown>).openrouter;
    if (!entry || typeof entry !== "object") return undefined;
    const record = entry as Record<string, unknown>;
    // OpenRouter's OAuth exchange itself returns an API key, so OpenCode normalizes both
    // "Connect in my browser" and pasted-key setup to `{ type: "api", key }`. `access` is a
    // defensive fallback only, in case a future OpenCode release stores a bare OAuth token instead.
    const key = record.type === "api" ? record.key : record.access;
    return typeof key === "string" && KEY_PATTERN.test(key) ? key : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

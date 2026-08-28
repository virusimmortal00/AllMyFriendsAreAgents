import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CLIENT_ID = /^[A-Za-z0-9._-]{10,200}$/;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const EXACT_FIELDS = ["appName", "appSlug", "clientId", "schemaVersion"];

export interface BundledGitHubAppConfiguration {
  readonly schemaVersion: 1;
  readonly appName: string;
  readonly appSlug: string;
  /** Public OAuth client identifier. This is intentionally safe to bundle and display. */
  readonly clientId: string;
}

export async function loadBundledGitHubAppConfiguration(filePath: string) {
  const raw = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Bundled GitHub App configuration is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Bundled GitHub App configuration is not canonical.");
  const value = parsed as Partial<BundledGitHubAppConfiguration>;
  if (Object.keys(parsed).sort().join("\0") !== EXACT_FIELDS.join("\0") || value.schemaVersion !== 1
    || typeof value.appName !== "string" || value.appName.length < 3 || value.appName.length > 100
    || typeof value.appSlug !== "string" || !APP_SLUG.test(value.appSlug)
    || typeof value.clientId !== "string" || !CLIENT_ID.test(value.clientId)) {
    throw new Error("Bundled GitHub App configuration is not canonical.");
  }
  return structuredClone(value) as BundledGitHubAppConfiguration;
}

/** Keeps the generated wrapping key outside both repository data and the checkout by default. */
export function defaultGitHubCredentialKeyPath(projectRoot: string, homeDirectory = os.homedir()) {
  const projectKey = createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 24);
  return path.join(homeDirectory, ".allmyfriendsareagents", "keys", projectKey, "github-credentials.key");
}

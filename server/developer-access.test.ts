import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { developerRequestAuthorized, developerTokenPath, openDeveloperToken, readDeveloperToken } from "./developer-access.js";

describe("developer access", () => {
  it("creates and reuses a private local token", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-developer-access-"));
    const first = await openDeveloperToken(directory, {});
    const second = await openDeveloperToken(directory, {});

    expect(first.token).toHaveLength(43);
    expect(second.token).toBe(first.token);
    expect(await readDeveloperToken(directory, {})).toBe(first.token);
    expect((await readFile(developerTokenPath(directory), "utf8")).trim()).toBe(first.token);
    expect((await stat(developerTokenPath(directory))).mode & 0o777).toBe(0o600);
  });

  it("accepts only an exact bearer token", () => {
    const token = "a".repeat(32);
    expect(developerRequestAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(developerRequestAuthorized(`Bearer ${"b".repeat(32)}`, token)).toBe(false);
    expect(developerRequestAuthorized(token, token)).toBe(false);
    expect(developerRequestAuthorized(undefined, token)).toBe(false);
  });

  it("rejects short configured tokens", async () => {
    await expect(openDeveloperToken("/unused", {
      ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TOKEN: "too-short",
    })).rejects.toThrow("at least 32 characters");
  });
});

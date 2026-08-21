import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { developerTokenPath } from "./developer-access.js";
import { DEVELOPER_TEAM_FILE, openDeveloperTeamRegistry } from "./developer-team.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("developer team registry", () => {
  it("migrates the singular token without changing identity or widening authority", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-developer-team-"));
    directories.push(directory);
    const token = "legacy-token-that-is-at-least-thirty-two-characters";
    const registry = await openDeveloperTeamRegistry(directory, { ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TOKEN: token });

    expect(registry.authenticate(`Bearer ${token}`, "ROOM_CHAT")?.member.memberId).toBe("developer-agent");
    expect(registry.authenticate(`Bearer ${token}`, "IMPROVEMENT_CLAIM")).toBeNull();
    expect(registry.roster()).toEqual([expect.objectContaining({ memberId: "developer-agent", revision: 1, presence: "OFFLINE" })]);
    expect(JSON.parse(await readFile(path.join(directory, DEVELOPER_TEAM_FILE), "utf8")).members[0].capabilities).toEqual(["ROOM_READ", "ROOM_CHAT"]);
  });

  it("appends immutable member configuration revisions and separates roster presence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-developer-team-"));
    directories.push(directory);
    const base = { ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TOKEN: "legacy-token-that-is-at-least-thirty-two-characters" };
    await openDeveloperTeamRegistry(directory, base);
    const token = "team-member-token-that-is-at-least-thirty-two-characters";
    const config = [{ memberId: "builder-1", displayName: "Builder One", roles: ["OPERATOR"], capabilities: ["IMPROVEMENT_CLAIM"], token }];
    const first = await openDeveloperTeamRegistry(directory, { ...base, ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TEAM_JSON: JSON.stringify(config) });
    const second = await openDeveloperTeamRegistry(directory, { ...base, ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TEAM_JSON: JSON.stringify([{ ...config[0], capabilities: ["IMPROVEMENT_CLAIM", "IMPROVEMENT_READ"] }]) });

    expect(first.latest("builder-1")?.revision).toBe(1);
    expect(second.latest("builder-1")?.revision).toBe(2);
    expect(second.revisions.filter(({ memberId }) => memberId === "builder-1")).toHaveLength(2);
    second.setPresence("builder-1", "WORKING");
    expect(second.roster().find(({ memberId }) => memberId === "builder-1")?.presence).toBe("WORKING");
    await expect(readFile(developerTokenPath(directory), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

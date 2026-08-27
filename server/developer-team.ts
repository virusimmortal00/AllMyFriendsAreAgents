import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActorRole, DomainActor } from "../shared/improvement-domain.js";
import { developerTokenPath, openDeveloperToken } from "./developer-access.js";

export const DEVELOPER_TEAM_FILE = "developer-team.json";

export type DeveloperCapability =
  | "ROOM_READ"
  | "ROOM_CHAT"
  | "CONSULTATION_READ"
  | "CONSULTATION_WRITE"
  | "CONSULTATION_CANCEL"
  | "COMMAND_RUN"
  | "DIAGNOSTIC_READ"
  | "IMPROVEMENT_READ"
  | "IMPROVEMENT_CLAIM"
  | "IMPROVEMENT_EVIDENCE"
  | "IMPROVEMENT_REVIEW"
  | "IMPROVEMENT_TRANSITION"
  | "ASSIGNMENT_WRITE"
  | "TASK_READ"
  | "TASK_PROPOSE"
  | "TASK_UPDATE"
  | "CONTINUATION_RUN"
  | "GITHUB_READ"
  | "GITHUB_COMMENT"
  | "GITHUB_PUBLISH_DRAFT"
  | "GITHUB_PR_METADATA"
  | "GITHUB_REQUEST_REVIEW"
  | "CONTRIBUTION_HANDOFF"
  | "CONTRIBUTION_REVIEW";

export type DeveloperPresence = "SLEEPING" | "AVAILABLE" | "WORKING" | "COOLING_DOWN" | "OFFLINE";

export interface DeveloperTeamMemberRevision {
  readonly memberId: string;
  readonly revision: number;
  readonly displayName: string;
  readonly roles: readonly ActorRole[];
  readonly capabilities: readonly DeveloperCapability[];
  readonly tokenHash: string;
  readonly createdAt: string;
}

interface StoredDeveloperTeam {
  readonly schemaVersion: 1;
  readonly members: readonly DeveloperTeamMemberRevision[];
}

interface ConfiguredDeveloperMember {
  readonly memberId: string;
  readonly displayName: string;
  readonly roles: readonly ActorRole[];
  readonly capabilities: readonly DeveloperCapability[];
  readonly token: string;
}

export interface AuthenticatedDeveloper {
  readonly member: DeveloperTeamMemberRevision;
  readonly actor: DomainActor;
}

export class DeveloperTeamRegistry {
  private readonly presence = new Map<string, DeveloperPresence>();

  constructor(readonly revisions: readonly DeveloperTeamMemberRevision[]) {
    const current = this.roster().map(({ memberId }) => this.latest(memberId)!);
    if (new Set(current.map(({ tokenHash }) => tokenHash)).size !== current.length) {
      throw new Error("Current developer team members must not share authentication tokens.");
    }
  }

  roster() {
    const latest = new Map<string, DeveloperTeamMemberRevision>();
    for (const revision of this.revisions) {
      if ((latest.get(revision.memberId)?.revision ?? 0) < revision.revision) latest.set(revision.memberId, revision);
    }
    return [...latest.values()].map((member) => ({ ...member, tokenHash: undefined, presence: this.presence.get(member.memberId) ?? "OFFLINE" as const }));
  }

  setPresence(memberId: string, presence: DeveloperPresence) {
    if (!this.latest(memberId)) throw new Error(`Unknown developer team member ${memberId}`);
    this.presence.set(memberId, presence);
  }

  latest(memberId: string) {
    return this.revisions.filter((candidate) => candidate.memberId === memberId).sort((a, b) => b.revision - a.revision)[0];
  }

  authenticate(authorization: string | undefined, capability: DeveloperCapability, preferredRole: ActorRole = "AUTHOR"): AuthenticatedDeveloper | null {
    if (!authorization?.startsWith("Bearer ")) return null;
    const suppliedHash = hashToken(authorization.slice("Bearer ".length).trim());
    const member = this.revisions
      .filter((candidate) => safeEqual(candidate.tokenHash, suppliedHash))
      .sort((a, b) => b.revision - a.revision)[0];
    if (!member || this.latest(member.memberId)?.revision !== member.revision || !member.capabilities.includes(capability)) return null;
    const role = member.roles.includes(preferredRole) ? preferredRole : member.roles[0];
    if (!role) return null;
    return { member, actor: { id: member.memberId, role, human: false } };
  }
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function openDeveloperTeamRegistry(dataDirectory: string, environment: NodeJS.ProcessEnv = process.env) {
  await mkdir(dataDirectory, { recursive: true });
  const registryPath = path.join(dataDirectory, DEVELOPER_TEAM_FILE);
  try {
    const stored = JSON.parse(await readFile(registryPath, "utf8")) as StoredDeveloperTeam;
    if (stored.schemaVersion !== 1 || !Array.isArray(stored.members)) throw new Error(`Developer team registry at ${registryPath} is invalid.`);
    await chmod(registryPath, 0o600);
    return new DeveloperTeamRegistry(await applyConfiguredRevisions(registryPath, stored, environment));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // Compatibility migration: retain the legacy identity and token, but grant only
  // the two room capabilities it historically possessed. Improvement authority
  // must be configured explicitly and is never inferred during migration.
  const legacy = await openDeveloperToken(dataDirectory, environment);
  const createdAt = new Date().toISOString();
  const stored: StoredDeveloperTeam = {
    schemaVersion: 1,
    members: [{
      memberId: "developer-agent",
      revision: 1,
      displayName: environment.ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_NAME?.trim() || "Legacy Developer Agent",
      roles: ["AUTHOR"],
      capabilities: ["ROOM_READ", "ROOM_CHAT"],
      tokenHash: hashToken(legacy.token),
      createdAt,
    }],
  };
  await writeFile(registryPath, `${JSON.stringify(stored, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  // The legacy token file deliberately remains in place so existing clients and
  // attribution continue to work during rollout.
  await chmod(developerTokenPath(dataDirectory), 0o600).catch(() => undefined);
  return new DeveloperTeamRegistry(await applyConfiguredRevisions(registryPath, stored, environment));
}

async function applyConfiguredRevisions(registryPath: string, stored: StoredDeveloperTeam, environment: NodeJS.ProcessEnv) {
  const revisions = [...stored.members];
  const legacyToken = environment.ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TOKEN?.trim();
  if (legacyToken) {
    if (legacyToken.length < 32) throw new Error("ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TOKEN must be at least 32 characters.");
    const previous = revisions.filter((candidate) => candidate.memberId === "developer-agent").sort((a, b) => b.revision - a.revision)[0];
    const tokenHash = hashToken(legacyToken);
    const displayName = environment.ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_NAME?.trim() || previous?.displayName || "Legacy Developer Agent";
    if (previous && (previous.tokenHash !== tokenHash || previous.displayName !== displayName)) {
      revisions.push({ ...previous, revision: previous.revision + 1, displayName, tokenHash, createdAt: new Date().toISOString() });
    }
  }
  const raw = environment.ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TEAM_JSON?.trim();
  if (!raw) {
    if (revisions.length !== stored.members.length) await writeFile(registryPath, `${JSON.stringify({ schemaVersion: 1, members: revisions }, null, 2)}\n`, { mode: 0o600 });
    return revisions;
  }
  const configured = JSON.parse(raw) as readonly ConfiguredDeveloperMember[];
  if (!Array.isArray(configured)) throw new Error("ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TEAM_JSON must be an array.");
  for (const member of configured) {
    if (!member.memberId?.trim() || !member.displayName?.trim() || !Array.isArray(member.roles) || !Array.isArray(member.capabilities) || member.token?.length < 32) {
      throw new Error("Each configured developer team member requires an ID, name, roles, capabilities, and a token of at least 32 characters.");
    }
    const previous = revisions.filter((candidate) => candidate.memberId === member.memberId).sort((a, b) => b.revision - a.revision)[0];
    const tokenHash = hashToken(member.token);
    const unchanged = previous
      && previous.displayName === member.displayName
      && JSON.stringify(previous.roles) === JSON.stringify(member.roles)
      && JSON.stringify(previous.capabilities) === JSON.stringify(member.capabilities)
      && previous.tokenHash === tokenHash;
    if (!unchanged) {
      revisions.push({
        memberId: member.memberId,
        revision: (previous?.revision ?? 0) + 1,
        displayName: member.displayName,
        roles: [...member.roles],
        capabilities: [...member.capabilities],
        tokenHash,
        createdAt: new Date().toISOString(),
      });
    }
  }
  if (revisions.length !== stored.members.length) {
    await writeFile(registryPath, `${JSON.stringify({ schemaVersion: 1, members: revisions }, null, 2)}\n`, { mode: 0o600 });
  }
  return revisions;
}

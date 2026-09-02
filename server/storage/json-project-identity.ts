import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { GitHubIntegrationStore } from "../github-integration-store.js";
import { ProjectRepositoryConnectionStore } from "../project-repository-connection.js";

const LEGACY_PROJECT_ID = /^legacy-project:[a-f0-9]{32}$/;

/** Resolve before RoomStore normalizes a moved path. Identity is not filesystem authority. */
export async function openJsonProjectIdentity(stateDirectory: string, defaultProjectPath: string): Promise<string> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const filePath = path.join(stateDirectory, "project-identity.json");
  const raw = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw !== undefined) {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("JSON project identity is malformed; restore it from a consistent backup."); }
    const identity = value as { schemaVersion?: unknown; projectId?: unknown } | null;
    if (!identity || identity.schemaVersion !== 1 || typeof identity.projectId !== "string" || !LEGACY_PROJECT_ID.test(identity.projectId)) {
      throw new Error("JSON project identity is malformed; restore it from a consistent backup.");
    }
    await chmod(filePath, 0o600);
    return identity.projectId;
  }

  // Older releases may already have replaced room.json's old checkout path.
  // Recover only an unambiguous key from canonical, non-secret authority stores.
  const [repositories, integrations] = await Promise.all([
    ProjectRepositoryConnectionStore.open(stateDirectory), GitHubIntegrationStore.open(stateDirectory),
  ]);
  const candidates = new Set([...repositories.list(), ...integrations.bindings()]
    .map((record) => record.projectId).filter((id) => LEGACY_PROJECT_ID.test(id)));
  if (candidates.size > 1) throw new Error("JSON project identity is ambiguous; reconcile the legacy project records before startup.");
  let projectId = [...candidates][0];
  if (!projectId) {
    const stored = await readFile(path.join(stateDirectory, "room.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const projectPath: unknown = stored === undefined ? defaultProjectPath : JSON.parse(stored).settings?.projectPath;
    if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) throw new Error("JSON project path cannot establish a legacy identity.");
    const canonical = await realpath(projectPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return projectPath;
      throw error;
    });
    projectId = `legacy-project:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
  }
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify({ schemaVersion: 1, projectId }, null, 2)}\n`);
      await file.sync();
    } finally { await file.close(); }
    // Publish atomically without overwriting an identity established by another opener.
    await link(temporary, filePath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  } finally { await unlink(temporary).catch(() => undefined); }
  return openJsonProjectIdentity(stateDirectory, defaultProjectPath);
}

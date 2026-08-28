import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DurableServerRecord } from "./identity-domain.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Durable compatibility identity for the legacy single-room JSON backend. */
export async function openJsonServerIdentity(stateDirectory: string): Promise<DurableServerRecord> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const filePath = path.join(stateDirectory, "server-identity.json");
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as DurableServerRecord;
    if (value.schemaVersion !== 1 || !UUID.test(value.serverId) || value.revision !== 1 || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
      throw new Error("JSON server identity is malformed; restore it or migrate the single-room state to SQLite.");
    }
    await chmod(filePath, 0o600);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const timestamp = new Date().toISOString();
    const value: DurableServerRecord = { schemaVersion: 1, serverId: randomUUID(), revision: 1, createdAt: timestamp, updatedAt: timestamp };
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
    return value;
  }
}

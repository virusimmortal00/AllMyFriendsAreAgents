import { mkdir, writeFile, readFile, unlink, rmdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

/** Serialize lifecycle checks and mutations across independent CLI processes.
 * The sibling directory survives a data purge. Abandoned locks fail closed and
 * are never broken by elapsed time while an operation might still own them.
 */
export async function withLifecycleLock(root, action) {
  const directory = `${path.resolve(root)}.lifecycle-lock`;
  const owner = path.join(directory, "owner.json");
  const token = randomBytes(32).toString("hex");
  await mkdir(path.dirname(directory), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(directory, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt === 100) throw new Error("Another lifecycle operation holds the lock. See native release operations for abandoned-lock recovery.");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  let recorded = false;
  try {
    await writeFile(owner, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
    recorded = true;
    return await action();
  } finally {
    if (recorded) {
      const value = JSON.parse(await readFile(owner, "utf8"));
      if (value.token === token) { await unlink(owner); await rmdir(directory); }
    } else {
      // Only remove an empty directory when writing the owner record failed.
      await rmdir(directory).catch(() => {});
    }
  }
}

import type express from "express";
import type { ProjectRepositoryConnectionStore, ProjectRepositoryConnectionService } from "./project-repository-connection.js";

/** Aggregate local authority only. Never discloses repository identities or paths. */
export function registerRepositoryReadiness(app: express.Express,
  store: Pick<ProjectRepositoryConnectionStore, "list">,
  service: (projectId: string) => Pick<ProjectRepositoryConnectionService, "revalidateAuthority">,
  timeoutMs = 35_000) {
  let pending: Promise<boolean> | undefined;
  const check = async () => {
    try {
      const results = await Promise.all(store.list().filter((connection) => connection.state !== "disabled").map(async (connection) => {
        try { return (await service(connection.projectId).revalidateAuthority(connection.revision)).kind === "ok"; }
        catch { return false; }
      }));
      return results.every(Boolean);
    } catch { return false; }
  };
  app.get("/api/ready/repositories", async (_request, response) => {
    // Share inspections even after a response deadline, until all workers settle.
    // A slow filesystem must not cause overlapping waves of Git subprocesses.
    pending ??= check().finally(() => { pending = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([pending, new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })]).finally(() => clearTimeout(timer));
    response.set("Cache-Control", "no-store").status(ready ? 200 : 503).json({ ready });
  });
}

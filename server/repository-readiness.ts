import type express from "express";
import type { ProjectRepositoryConnectionStore, ProjectRepositoryConnectionService } from "./project-repository-connection.js";

/** Aggregate local authority only. Never discloses repository identities or paths. */
export function registerRepositoryReadiness(app: express.Express,
  store: Pick<ProjectRepositoryConnectionStore, "list">,
  service: (projectId: string) => Pick<ProjectRepositoryConnectionService, "revalidateAuthority">) {
  let pending: Promise<boolean> | undefined;
  const check = async () => {
    try {
      for (const connection of store.list()) {
        if (connection.state === "disabled") continue;
        if ((await service(connection.projectId).revalidateAuthority(connection.revision)).kind !== "ok") return false;
      }
      return true;
    } catch { return false; }
  };
  app.get("/api/ready/repositories", async (_request, response) => {
    // Concurrent health probes share one bounded Git inspection pass.
    pending ??= check().finally(() => { pending = undefined; });
    const ready = await pending;
    response.set("Cache-Control", "no-store").status(ready ? 200 : 503).json({ ready });
  });
}

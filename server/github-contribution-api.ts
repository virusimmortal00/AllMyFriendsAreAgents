import type express from "express";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import type { GitHubContributionBroker } from "./github-contribution-broker.js";
import { GITHUB_OPERATION_CAPABILITY, GITHUB_OPERATIONS, type GitHubBrokerRequest } from "./github-contribution-record.js";

export function registerGitHubContributionRoutes(input: {
  readonly app: express.Express;
  readonly broker?: GitHubContributionBroker;
  readonly developers: DeveloperTeamRegistry;
}) {
  const { app, broker, developers } = input;
  app.get("/api/developer/github/audit", (request, response) => {
    const auth = developers.authenticate(request.header("authorization"), "GITHUB_READ", "REVIEWER");
    if (!broker || !auth) return response.status(404).json({ error: "Not found." });
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));
    const records = broker.audit();
    return response.set("Cache-Control", "no-store").json({ records: records.slice(-limit) });
  });
  app.post("/api/developer/github", async (request, response) => {
    const command = request.body as GitHubBrokerRequest;
    if (!broker || !command || !GITHUB_OPERATIONS.includes(command.operation)) return response.status(404).json({ error: "Not found." });
    const auth = developers.authenticate(request.header("authorization"), GITHUB_OPERATION_CAPABILITY[command.operation]);
    if (!auth) return response.status(404).json({ error: "Not found." });
    const result = await broker.execute(auth, command);
    if (result.kind === "ok") return response.json(result);
    if (result.kind === "failed") return response.status(result.retryable ? 503 : 502).json(result);
    return response.status(403).json(result);
  });
}

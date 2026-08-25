import type { DeveloperTeamRegistry } from "./developer-team.js";
import type { GitHubContributionBroker } from "./github-contribution-broker.js";
import { GITHUB_POLICY_REVISION } from "./github-contribution-record.js";
import type { GitHubContributionClient } from "./github-client.js";
import type { ContributionExternalExecutor } from "./contribution-service.js";

export class GovernedContributionExecutor implements ContributionExternalExecutor {
  constructor(
    private readonly broker: GitHubContributionBroker,
    private readonly github: GitHubContributionClient,
    private readonly developers: DeveloperTeamRegistry,
    private readonly repository: string,
    private readonly baseBranch: string,
    private readonly deploymentUrl?: string,
    private readonly deploymentAuthorization?: string,
  ) {}

  async publish({ contribution, approval }: Parameters<ContributionExternalExecutor["publish"]>[0]) {
    const member = this.developers.latest(contribution.source.authorId); const role = member?.roles[0];
    if (!member || !role) throw new Error("Contribution author identity is unavailable");
    const result = await this.broker.execute({ member, actor: { id: member.memberId, role, human: false } }, {
      idempotencyKey: `publication:${approval.approvalId}`, operation: "PUBLISH_DRAFT_PULL_REQUEST", taskId: contribution.source.taskId,
      assignmentId: contribution.source.assignmentId, expectedTaskRevision: contribution.source.taskRevision, expectedAssignmentRevision: contribution.source.assignmentRevision,
      expectedFencingToken: contribution.source.fencingToken, expectedManifestRevision: contribution.source.manifestRevision, expectedPolicyRevision: GITHUB_POLICY_REVISION,
      expectedBaseSha: contribution.source.baseSha, expectedHeadSha: contribution.source.headSha, title: contribution.title, body: contribution.description,
    });
    if (result.kind !== "ok" || !result.value.number) throw retryableError(result.kind === "failed" ? result.reason : result.kind === "rejected" ? result.reason : "Draft pull request publication failed", result.kind === "failed" && result.retryable);
    return { number: result.value.number, url: result.value.url, resultId: result.value.id };
  }

  async merge({ contribution }: Parameters<ContributionExternalExecutor["merge"]>[0]) {
    if (!contribution.pullRequest) throw new Error("Published pull request is missing");
    if (await this.github.readBranchHead(this.repository, this.baseBranch) !== contribution.source.baseSha) throw new Error("Protected base changed after review");
    const identity = await this.github.pullRequestIdentity(this.repository, contribution.pullRequest.number);
    if (identity.state !== "open" || identity.headSha !== contribution.source.headSha || identity.baseSha !== contribution.source.baseSha || identity.headRef !== contribution.source.branch) throw new Error("Pull request identity changed after publication");
    if (identity.draft) await this.github.markPullRequestReady(this.repository, contribution.pullRequest.number);
    const ready = await this.github.pullRequestIdentity(this.repository, contribution.pullRequest.number);
    if (ready.state !== "open" || ready.draft || ready.headSha !== contribution.source.headSha || ready.baseSha !== contribution.source.baseSha || ready.headRef !== contribution.source.branch) throw new Error("Pull request readiness changed the exact reviewed identity");
    const result = await this.github.mergePullRequest(this.repository, contribution.pullRequest.number, contribution.source.headSha);
    return { commitSha: result.commitSha, resultId: result.id };
  }

  async deploy({ contribution, approval }: Parameters<ContributionExternalExecutor["deploy"]>[0]) {
    if (!this.deploymentUrl || !approval.environment || !approval.artifactDigest || !contribution.merged) throw new Error("Deployment executor or exact deployment identity is unavailable");
    const response = await fetch(this.deploymentUrl, { method: "POST", headers: { "Content-Type": "application/json", ...(this.deploymentAuthorization ? { Authorization: this.deploymentAuthorization } : {}) },
      body: JSON.stringify({ contributionId: contribution.contributionId, approvalId: approval.approvalId, repository: contribution.source.repository,
        environment: approval.environment, commitSha: contribution.merged.commitSha, artifactDigest: approval.artifactDigest }), signal: AbortSignal.timeout(60_000) }).catch(() => { throw retryableError("Deployment executor transport failed", true); });
    const text = await response.text(); if (!response.ok) throw retryableError(`Deployment executor failed with ${response.status}`, response.status === 429 || response.status >= 500);
    const result = text ? JSON.parse(text) as { resultId?: string; commitSha?: string; environment?: string; artifactDigest?: string } : {};
    if (!result.resultId || result.commitSha !== contribution.merged.commitSha || result.environment !== approval.environment || result.artifactDigest !== approval.artifactDigest) throw new Error("Deployment executor returned mismatched exact evidence");
    return { resultId: result.resultId, commitSha: result.commitSha, environment: result.environment, artifactDigest: result.artifactDigest };
  }
}

export class UnavailableContributionExecutor implements ContributionExternalExecutor {
  async publish(): Promise<never> { throw new Error("GitHub publication executor is not configured"); }
  async merge(): Promise<never> { throw new Error("GitHub merge executor is not configured"); }
  async deploy(): Promise<never> { throw new Error("Deployment executor is not configured"); }
}

function retryableError(message: string, retryable: boolean) { return Object.assign(new Error(message), { retryable }); }

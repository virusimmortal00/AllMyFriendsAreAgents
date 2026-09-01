import { DEFAULT_PARTICIPANT_STYLES } from "../../shared/chat-style";
import { ROOM_PROTOCOL_VERSION } from "../../shared/protocol";
import type { ModelDiscoveryResult } from "../../shared/model-discovery";
import type { RoomState, HumanPresence } from "../../src/types";
import { visualRoster } from "./fixtures";
import { normalizeRoomAgentRoster } from "../../shared/roster";

export const fixtureTime = "2026-08-30T12:00:00.000Z";
export const fixtureHuman: HumanPresence = { id: "visual-human", name: "Alex", style: DEFAULT_PARTICIPANT_STYLES.you };
export const fixtureRoom: RoomState = {
  messages: [
    { id: "welcome", speaker: "you", speakerName: "Alex", text: "Let’s review the navigation and make every screen easier to use.", timestamp: fixtureTime },
    { id: "reply", speaker: visualRoster.entries[0].agentId, text: "Start with a clear route back to the conversation, then check the smaller screen sizes.\n\nSee [[improvement:navigation-review]] for the recorded evidence.", timestamp: fixtureTime },
  ],
  settings: { roomName: "Design Workshop", topic: "A consistent experience across screen sizes", conversationEnergy: "balanced", participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES) },
  status: "idle", humans: [fixtureHuman], roster: normalizeRoomAgentRoster(visualRoster),
  server: { instanceId: "visual-server", protocolVersion: ROOM_PROTOCOL_VERSION },
};
export const fixtureModels: ModelDiscoveryResult = {
  status: "available", discoveredAt: fixtureTime,
  models: ["Atlas", "Beacon", "Compass", "Delta"].map((name, index) => ({
    providerId: "fixture-provider", modelId: `fixture-${name.toLowerCase()}`, displayName: `${name} Reasoning`, authorId: "fixture-provider", authorDisplayName: "Fixture Provider", accessProviderDisplayName: "Fixture Provider", provenance: "opencode-catalog",
    description: "A fictional model for deterministic interface checks. Supports conversation, reasoning, and structured tools.",
    limits: { context: 128000, output: 16000 }, pricing: { inputPerMillion: index + 0.5, outputPerMillion: index + 2 },
    variants: [{ id: "balanced", displayName: "Balanced" }, { id: "deep", displayName: "Deep reasoning" }],
    capabilities: { reasoning: true, toolCall: true, inputModalities: ["text", "image"], outputModalities: ["text"] },
  })),
};
const settings = { configurationRevision: 1, basePromptRevision: 1, basePromptText: "Contribute only when there is useful new information. Keep replies clear and support factual claims with evidence.", summarizerModel: null, summarizerPromptText: "Summarize the decisions, unresolved questions, and next actions in {{transcript}}.", summarizerPromptRevision: 1, featureFlags: {}, preflightMode: "off", updatedAt: fixtureTime };
const task = { roomId: "visual-room", taskId: "task-navigation", title: "Review navigation across screen sizes", description: "Verify the list, detail, and recovery flows. Record screenshots and preserve the classic interface style.", state: "active", participants: [{ participantId: "Alex", role: "owner", addedAt: fixtureTime, addedBy: "Alex" }], dependencies: [], blockers: [], references: [], forkedFrom: null, revision: 2, createdAt: fixtureTime, updatedAt: fixtureTime, attribution: [], lifecycleHistory: [] };
const improvement = { canonicalId: "navigation-review", revisionLabel: "r2", state: "IN_PROGRESS", risk: "GUARDED", updatedAt: fixtureTime,
  status: { schemaVersion: 1, implementation: { state: "IMPLEMENTED", codeLocation: { immutableRevision: "a".repeat(40), repository: "example/navigation", branch: "main", worktree: null } }, deployment: { state: "NOT_DEPLOYED" }, developerTeamEvidence: { state: "AVAILABLE", evidence: [{ id: "evidence-1", uri: "https://example.com/evidence" }] }, independentAcceptance: { state: "AWAITING_REVIEW" }, upstreamPublication: { state: "UNPUBLISHED" }, nextAction: { state: "ACTION_REQUIRED", action: "Review the rendered evidence" } },
  evidence: [{ id: "evidence-1", introducedRevision: 2, revisionLabel: "r2", sourceClass: "DEVELOPER_TEAM", kind: "test", uri: "https://example.com/evidence", summary: "Navigation regression checks", recordedAt: fixtureTime }], revisions: [], milestones: [{ id: "milestone-1", introducedRevision: 2, revisionLabel: "r2", state: "ACHIEVED", summary: "Shared navigation available", recordedAt: fixtureTime }],
};
const heartbeat = { configured: true, active: false, runtime: { revision: 1, enabled: false, emergencyStopped: false, changedBy: null, changedAt: null, reason: null }, policy: { version: "heartbeat-policy-v1", cadenceMs: 30000, maxConcurrency: 1, maxSelectedPerRun: 5, maxDispatchedPerRun: 2, maxAttemptsPerRevision: 3, retryAfterMs: 120000, timeBudgetMs: 60000, permittedCapabilities: ["ANALYZE", "RUN_TESTS"], prohibitedCapabilities: ["COMMIT"], eligibleStates: ["APPROVED", "IN_PROGRESS"], governedProposalRequired: true }, audit: [] };
const usage = { elapsedMs: 1200, tokens: 320, toolCalls: 2, attempts: 1 };
const budget = { timeMs: 60000, tokenLimit: 6000, toolCallLimit: 16, retryLimit: 1 };
const continuations = { policy: { revision: 2, enabled: true, policyVersion: "continuation-policy-v1", updatedAt: fixtureTime, defaultBudget: budget }, jobs: [{ jobId: "continuation-1", jobRevision: 2, owner: "codex-sol", task: { roomId: "visual-room", taskId: task.taskId }, taskRevision: 2, assignmentId: "assignment-navigation", objective: "Verify the remaining responsive navigation checks", trigger: "Explicit request", status: "BLOCKED", resultDisposition: "PENDING", resultSummary: null, blocker: "Waiting for review of the rendered evidence", nextEligibilityAt: null, updatedAt: fixtureTime, usage }] };
const investigations = { policy: { revision: 2, enabled: true, policyVersion: "investigation-policy-v1", maxConcurrentGlobal: 2, updatedAt: fixtureTime, defaultBudget: budget }, jobs: [{ investigationId: "investigation-1", revision: 2, owner: "codex-sol", objective: "Check navigation recovery after a connection interruption", trigger: "Connection notice", signal: "AGENT_DECISION", evidenceRefs: [], status: "CHECKPOINTED", usage, providerSessionEstablished: true, checkpoint: { attempt: 1, summary: "The draft remains available after reconnecting", createdAt: fixtureTime }, resultSummary: null, unresolvedQuestions: ["Are the recovery actions clear at every width?"], resultWaiting: false, blocker: "Ready for the next bounded check", createdAt: fixtureTime, updatedAt: fixtureTime, completedAt: null }] };
const contribution = { contributionId: "contribution-navigation", revision: 2, stage: "REVIEW_ACCEPTED", title: "Consistent navigation controls", description: "Shared navigation and responsive layout improvements.", blockedReason: null, updatedAt: fixtureTime, source: { repository: "example/navigation", branch: "feature/navigation", baseSha: "a".repeat(40), headSha: "b".repeat(40), taskId: task.taskId, taskRevision: 2, assignmentId: "assignment-navigation", assignmentRevision: 2, manifestRevision: 1 }, review: { reviewerId: "reviewer", decision: "ACCEPTED", summary: "The bounded checks pass.", at: fixtureTime }, pullRequest: null, merged: null, deployed: null, approvals: [] };
const connection = { connectionId: "github-visual", revision: 1, authMode: "github-device-user", state: "ready", githubUser: { id: 123, login: "example-contributor" }, connectedAt: fixtureTime, lastValidatedAt: fixtureTime, updatedAt: fixtureTime };
const repository = { githubRepositoryId: 1234, installationId: 123, owner: "example", name: "navigation", canonical: "example/navigation", visibility: "public", defaultBranch: "main" };

export interface FixtureResponse { status: number; body: unknown; }
// Explicit, deterministic responses only. No network access, auth secrets, or live mutations.
export function appFixtureResponse(path: string, method: string, scenario: string): FixtureResponse {
  const url = new URL(path, "http://fixture.invalid");
  const route = url.pathname;
  const ok = (body: unknown): FixtureResponse => ({ status: 200, body });
  const unauthorized = { status: 401, body: { error: "Owner sign-in required." } };
  if (method === "GET") {
    if (route === "/api/ready") return ok(fixtureRoom.server);
    if (route === "/api/state") return ok(fixtureRoom);
    if (route === "/api/polls") return ok({ items: scenario === "poll-cards" ? [{ pollId: "poll-navigation", revision: 1, question: "Which view should we review next?", options: ["Room properties", "Task details"], tallies: [2, 1], state: "OPEN", totalVotes: 3, closedAt: null, ownVote: null, canClose: true }] : [] });
    if (route === "/api/roster") return scenario === "manage-agents-sign-in" ? unauthorized : ok({ roster: visualRoster, catalog: [], ...(scenario === "manage-agents-model-picker" ? { modelDiscovery: fixtureModels } : {}) });
    if (route === "/api/room/settings") return ok({ settings, defaults: { basePromptText: settings.basePromptText } });
    if (route === "/api/room/settings/models") return ok(fixtureModels);
    if (route === "/api/model-details") return ok({ providerId: "fixture-provider", modelId: url.searchParams.get("modelId"), offers: [], fetchedAt: fixtureTime });
    if (route === "/api/control/me") return ["github-admin-sign-in", "github-claim-owner", "manage-agents-sign-in"].includes(scenario) ? unauthorized : ok({ principal: { id: "visual-owner", username: "owner", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "fictional-fixture-csrf" });
    if (route === "/api/control/status") return ok({ claimed: scenario !== "github-claim-owner", bootstrapConfigured: true });
    if (route === "/api/control/integrations/github") return ok({ app: { name: "Example application", slug: "example-application", clientId: "fictional-client" }, connections: ["github-connect", "github-device-auth"].includes(scenario) ? [] : [connection] });
    if (route === "/api/control/projects/current/repository") return ok({ repository: scenario === "github-configured-repo" ? { configured: true, revision: 1, state: "verified", repository: "github.com/example/navigation" } : { configured: false }, defaults: { checkoutPath: "/example/checkout", worktreeRoot: "/example/worktrees", policyRevision: 1 } });
    if (route === "/api/control/integrations/github/repositories") return ok({ catalog: { connectionId: connection.connectionId, connectionRevision: 1, revision: 1, observedAt: fixtureTime, installations: [{ installationId: 123, account: { id: 123, login: "example", type: "Organization" }, repositorySelection: "selected" }], repositories: scenario === "github-empty-repo" ? [] : [repository] } });
    if (route === "/api/tasks") return ok({ items: [task], nextCursor: null });
    if (route === `/api/tasks/${task.taskId}`) return ok({ task, relationships: { dependencies: [], blockers: [], dependents: [] }, history: [{ revision: 1, actorId: "Alex", at: fixtureTime, change: "create" }] });
    if (route === "/api/improvements") return ok({ scope: "active", items: [improvement] });
    if (route === "/api/improvements/navigation-review") return ok(improvement);
    if (route === "/api/improvements/missing-review") return { status: 404, body: { error: "Improvement not found" } };
    if (route === "/api/heartbeat") return ok(heartbeat);
    if (route === "/api/continuations") return ok(continuations);
    if (route.startsWith("/api/continuations/inbox/")) return ok([{ inboxEntryId: "continuation-result", inboxRevision: 1, owner: "codex-sol", jobId: "continuation-1", task: { taskId: task.taskId }, assignmentId: "assignment-navigation", status: "UNREAD", summary: "Navigation checks are ready for review.", createdAt: fixtureTime, expiresAt: "2026-09-30T12:00:00Z" }]);
    if (route === "/api/investigations") return ok(investigations);
    if (route.startsWith("/api/investigations/inbox/")) return ok([{ inboxEntryId: "investigation-result", revision: 1, investigationId: "investigation-1", owner: "codex-sol", status: "UNREAD", summary: "The draft was preserved during recovery.", evidenceRefs: [], unresolvedQuestions: ["Confirm the smaller layout."], createdAt: fixtureTime, updatedAt: fixtureTime, expiresAt: "2026-09-30T12:00:00Z" }]);
    if (route === "/api/contributions") return ok({ items: [contribution] });
    if (route === `/api/contributions/${contribution.contributionId}`) return ok({ contribution, audit: [{ eventId: "review-event", action: "REVIEW_ACCEPTED", actorId: "reviewer", at: fixtureTime, outcome: "ACCEPTED", detail: "The bounded checks pass.", externalResultId: null }] });
  }
  if (method === "POST" && route === "/api/humans") return ok(fixtureHuman);
  if (method === "PUT" && route === "/api/roster" && scenario === "manage-agents-conflict") return { status: 409, body: { error: "The roster changed. Load the latest roster and review your draft.", roster: { ...visualRoster, revision: 2 }, catalog: [] } };
  if (method === "POST" && route === "/api/control/integrations/github/device-authorizations") return ok({ authorization: { flowId: "visual-flow", state: "authorizing", challenge: { userCode: "DEMO-CODE", verificationUri: "https://github.com/login/device", expiresInSeconds: 900, intervalSeconds: 60 }, expiresAt: "2099-01-01T00:00:00Z" } });
  if (method === "POST" && route === "/api/control/diagnostics/query") return ok({ records: [{ recordId: "record-navigation", event: "Navigation check completed", stream: "server-service-lifecycle", timestamp: fixtureTime, severity: "info", correlationId: "navigation-check", content: { outcome: "verified", views: ["chat", "room-properties"], note: "Fictional diagnostic evidence for interface testing." } }], chunks: [], scannedBytes: 512, serializedBytes: 256, malformedRecords: 0, scanLimitReached: false, nextCursor: null });
  return { status: 501, body: { error: `Unmocked fixture API: ${method} ${route}` } };
}

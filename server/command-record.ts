import type { GitHubHttpDiagnostic } from "../shared/github-http-diagnostic.js";
import type { ActiveAgentId } from "../shared/participants.js";
import type { CommandInvocation, RoomCommandName } from "../shared/command-domain.js";
import type { GhCheck, GhIssue, GhPullRequest, GhRun, GitHubFailureKind } from "./github-read-adapter.js";

export type CommandInvoker = { readonly kind: "human" | "agent"; readonly id: string; readonly displayName: string };
export interface CommandSubmission { readonly submissionId: string; readonly roomId: string; readonly clientSubmissionId: string; readonly command: RoomCommandName; readonly invocation: CommandInvocation; readonly invoker: CommandInvoker; readonly createdAt: string }
export interface RoundRobinState { readonly roomId: string; readonly lastAssignedAgentId: ActiveAgentId | null; readonly revision: number; readonly updatedAt: string }
export interface CommandDeliveryResult { readonly sessionId?: string; readonly permission?: "read-only" | "writable"; readonly codeEpoch?: string; readonly cursorMessageId?: string }
export interface CommandAttempt { readonly attemptId: string; readonly roomId: string; readonly submissionId: string; readonly attempt: number; readonly agentId: ActiveAgentId; readonly generationId: string | null; readonly status: "queued" | "active" | "delivery-pending" | "completed" | "failed" | "superseded"; readonly reason: string | null; readonly deliveryMessages?: readonly string[]; readonly deliveryResult?: CommandDeliveryResult; readonly roomEpoch?: string; readonly rosterRevision?: number; readonly agentConfigurationRevision?: number; readonly createdAt: string; readonly updatedAt: string }
export interface CommandPoll {
  readonly pollId: string; readonly roomId: string; readonly submissionId: string;
  readonly question: string; readonly options: readonly [string, string, ...string[]];
  readonly creatorKind: CommandInvoker["kind"]; readonly creatorId: string;
  readonly state: "OPEN" | "CLOSED"; readonly revision: number;
  readonly closedAt: string | null; readonly closerKind: CommandInvoker["kind"] | "controller" | null;
  readonly closerId: string | null; readonly closeMutationId: string | null;
  readonly finalTallies: readonly number[] | null; readonly finalTotalVotes: number | null;
  readonly createdAt: string;
}
export interface CommandVote { readonly roomId: string; readonly pollId: string; readonly voterId: string; readonly mutationId: string; readonly optionIndex: number; readonly createdAt: string }
export interface CommandAuditIdentity { readonly auditId: string; readonly roomId: string; readonly submissionId: string; readonly command: RoomCommandName; readonly invokerKind: CommandInvoker["kind"]; readonly invokerId: string; readonly targetAgentIds: readonly ActiveAgentId[]; readonly createdAt: string }
export interface CommandPovExecution { readonly executionId: string; readonly roomId: string; readonly submissionId: string; readonly targetAgentIds: readonly ActiveAgentId[]; readonly processedTargetAgentIds: readonly ActiveAgentId[]; readonly currentTargetAgentId?: ActiveAgentId | null; readonly generationId?: string | null; readonly deliveryMessages?: readonly string[]; readonly deliveryResult?: CommandDeliveryResult; readonly roomEpoch?: string; readonly rosterRevision?: number; readonly agentConfigurationRevision?: number; readonly status: "queued" | "active" | "completed" | "failed" | "cancelled"; readonly reason: string | null; readonly createdAt: string; readonly updatedAt: string }
export interface CommandTombstone { readonly roomId:string; readonly submissionId:string; readonly clientSubmissionId:string; readonly command:RoomCommandName; readonly compactedAt:string }
export interface DiagnosticRecord { readonly recordId: string; readonly roomId: string; readonly agentId: ActiveAgentId; readonly attemptId: string; readonly generationId: string | null; readonly correlationId: string; readonly promptHead: string | null; readonly promptFingerprint: string; readonly reason: string; readonly metadata: Readonly<Record<string, string | number | boolean | null>>; readonly diagnosticText: string | null; readonly createdAt: string }
export type GhProjection =
  | { readonly kind: "recent"; readonly repository: string; readonly pulls: readonly GhPullRequest[]; readonly issues: readonly GhIssue[]; readonly runs: readonly GhRun[]; readonly truncated: boolean }
  | { readonly kind: "pr"; readonly repository: string; readonly pull: GhPullRequest }
  | { readonly kind: "issue"; readonly repository: string; readonly issue: GhIssue }
  | { readonly kind: "ci"; readonly repository: string; readonly pullNumber: number | null; readonly checks: readonly GhCheck[]; readonly truncated: boolean };
export interface GhExecutionDiagnostic extends GitHubHttpDiagnostic { readonly endpointFamily: import("./github-read-adapter.js").GitHubEndpointFamily; readonly cacheOutcome: "hit" | "miss" | "coalesced" | "refresh"; readonly queueDelayMs: number; readonly rateLimited: boolean; readonly truncated: boolean; readonly failureKind: GitHubFailureKind | null; readonly statusClass: "none" | "4xx" | "5xx"; readonly correlationId: string }
export interface CommandGhExecution { readonly executionId: string; readonly roomId: string; readonly submissionId: string; readonly status: "queued" | "completed" | "failed"; readonly deliveryStatus: "pending" | "delivered"; readonly authorizationLease: string | null; readonly projection: GhProjection | null; readonly renderedText: string | null; readonly failureKind: GitHubFailureKind | null; readonly diagnostics: readonly GhExecutionDiagnostic[]; readonly createdAt: string; readonly updatedAt: string }

/** Deliberately returned only from authenticated command/diagnostic endpoints. */
export interface PrivateCommandProjection { readonly submission: CommandSubmission; readonly attempts: readonly CommandAttempt[]; readonly audit: CommandAuditIdentity | null; readonly diagnostics: readonly DiagnosticRecord[] }
/** Safe poll card projection; invocation text, audit identity, and diagnostics are excluded. */
export interface PublicPollProjection { readonly pollId: string; readonly question: string; readonly options: readonly string[]; readonly tallies: readonly number[]; readonly totalVotes: number; readonly state: CommandPoll["state"]; readonly revision: number; readonly closedAt: string | null; readonly ownVote: number | null; readonly canClose: boolean }

export function publicPollProjection(poll: CommandPoll, votes: readonly CommandVote[], viewer?: { readonly kind: CommandInvoker["kind"] | "controller"; readonly id: string; readonly canControl?: boolean }): PublicPollProjection {
  const scoped = votes.filter((vote) => vote.roomId === poll.roomId && vote.pollId === poll.pollId && Number.isSafeInteger(vote.optionIndex) && vote.optionIndex >= 0 && vote.optionIndex < poll.options.length);
  const liveTallies = poll.options.map((_, index) => scoped.filter((vote) => vote.optionIndex === index).length);
  const tallies = poll.state === "CLOSED" && poll.finalTallies ? [...poll.finalTallies] : liveTallies;
  const ownVote = viewer ? scoped.find((vote) => vote.voterId === `${viewer.kind}:${viewer.id}`)?.optionIndex ?? null : null;
  return { pollId: poll.pollId, question: poll.question, options: [...poll.options], tallies, totalVotes: poll.state === "CLOSED" && poll.finalTotalVotes !== null ? poll.finalTotalVotes : scoped.length, state: poll.state, revision: poll.revision, closedAt: poll.closedAt, ownVote, canClose: Boolean(viewer && poll.state === "OPEN" && (viewer.canControl || viewer.kind === poll.creatorKind && viewer.id === poll.creatorId)) };
}

export const MAX_DIAGNOSTIC_TEXT = 2_000;
export const MAX_COMMAND_DELIVERY_MESSAGE = 4_000;
export const MAX_DIAGNOSTIC_PROMPT_HEAD = 300;
export const MAX_DIAGNOSTICS_PER_ROOM_AGENT = 200;
export const MAX_DIAGNOSTIC_QUERY_LIMIT = 200;
export const MAX_DIAGNOSTIC_SEARCH_LENGTH = 200;
export const DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const COMMAND_RECORD_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const MAX_OPEN_POLLS_PER_ROOM = 20;
export const MAX_COMMAND_SUBMISSIONS_PER_ROOM = 1_000;
export const MAX_COMMAND_TOMBSTONES_PER_ROOM = 2_000;
export const MAX_RECENT_POLLS = 100;

export function commandPollCursor(poll: Pick<CommandPoll, "createdAt" | "pollId">) {
  return `${poll.createdAt}|${encodeURIComponent(poll.pollId)}`;
}

export function parseCommandPollCursor(cursor: string | undefined) {
  if (!cursor) return undefined;
  const separator = cursor.indexOf("|");
  if (separator < 0) return { createdAt: cursor, pollId: "" };
  const createdAt = cursor.slice(0, separator);
  try { return { createdAt, pollId: decodeURIComponent(cursor.slice(separator + 1)) }; }
  catch { return undefined; }
}

export interface DiagnosticQuery {
  readonly agentId: ActiveAgentId;
  readonly limit?: number;
  readonly search?: string;
  readonly reason?: string;
}

export type CreateCommandSubmissionResult = { readonly kind: "created"; readonly submission: CommandSubmission } | { readonly kind: "duplicate"; readonly submission: CommandSubmission };
export type CreateCommandVoteResult = { readonly kind: "created"; readonly vote: CommandVote } | { readonly kind: "duplicate"; readonly vote: CommandVote } | { readonly kind: "rejected"; readonly reason: string };
export type CloseCommandPollResult = { readonly kind: "closed" | "duplicate"; readonly poll: CommandPoll } | { readonly kind: "conflict"; readonly poll: CommandPoll } | { readonly kind: "rejected" | "not-found"; readonly reason: string };
export interface CommandAcceptance {
  readonly submission: CommandSubmission;
  readonly audit: CommandAuditIdentity;
  readonly poll?: CommandPoll;
  readonly attempt?: CommandAttempt;
  readonly povExecution?: CommandPovExecution;
  readonly ghExecution?: CommandGhExecution;
  readonly roundRobin?: { readonly expectedRevision: number; readonly state: RoundRobinState };
}
export type AcceptCommandResult =
  | { readonly kind: "accepted"; readonly acceptance: CommandAcceptance }
  | { readonly kind: "duplicate"; readonly submission: CommandSubmission }
  | { readonly kind: "compacted-duplicate"; readonly tombstone:CommandTombstone }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "conflict"; readonly actualRevision: number };
export interface CommandReassignment { readonly expectedUpdatedAt:string; readonly current:CommandAttempt; readonly next:CommandAttempt; readonly roundRobin:{readonly expectedRevision:number;readonly state:RoundRobinState} }

export interface CommandRecordStore {
  acceptCommand(acceptance: CommandAcceptance): Promise<AcceptCommandResult>;
  reassignCommandAttempt(reassignment:CommandReassignment): Promise<{readonly kind:"accepted";readonly current:CommandAttempt;readonly next:CommandAttempt}|{readonly kind:"conflict"|"not-found"}>;
  createCommandSubmission(submission: CommandSubmission): Promise<CreateCommandSubmissionResult>;
  getCommandSubmission(roomId: string, submissionId: string): Promise<CommandSubmission | undefined>;
  getRoundRobinState(roomId: string): Promise<RoundRobinState>;
  compareAndSetRoundRobinState(expectedRevision: number, state: RoundRobinState): Promise<{ readonly kind: "accepted"; readonly state: RoundRobinState } | { readonly kind: "conflict"; readonly actualRevision: number }>;
  createCommandAttempt(attempt: CommandAttempt): Promise<{ readonly kind: "created" | "duplicate"; readonly attempt: CommandAttempt }>;
  listCommandAttempts(roomId: string, submissionId: string): Promise<readonly CommandAttempt[]>;
  listPendingCommandAttempts(roomId: string): Promise<readonly CommandAttempt[]>;
  compareAndSetCommandAttempt(expectedUpdatedAt: string, attempt: CommandAttempt): Promise<{ readonly kind: "accepted"; readonly attempt: CommandAttempt } | { readonly kind: "conflict" | "not-found" }>;
  createCommandPoll(poll: CommandPoll): Promise<{ readonly kind: "created" | "duplicate"; readonly poll: CommandPoll }>;
  listCommandPolls(roomId: string, query?:{readonly limit?:number;readonly before?:string;readonly state?:CommandPoll["state"]}): Promise<readonly CommandPoll[]>;
  getCommandPoll(roomId: string, pollId: string): Promise<CommandPoll | undefined>;
  createCommandVote(vote: CommandVote): Promise<CreateCommandVoteResult>;
  closeCommandPoll(input: { readonly roomId: string; readonly pollId: string; readonly expectedRevision: number; readonly mutationId: string; readonly closerKind: CommandInvoker["kind"] | "controller"; readonly closerId: string; readonly closedAt: string }): Promise<CloseCommandPollResult>;
  listCommandVotes(roomId: string, pollId: string): Promise<readonly CommandVote[]>;
  createCommandAuditIdentity(audit: CommandAuditIdentity): Promise<{ readonly kind: "created" | "duplicate"; readonly audit: CommandAuditIdentity }>;
  getCommandAuditIdentity(roomId: string, submissionId: string): Promise<CommandAuditIdentity | undefined>;
  listCommandAuditIdentities(roomId: string): Promise<readonly CommandAuditIdentity[]>;
  listPendingPovExecutions(roomId: string): Promise<readonly CommandPovExecution[]>;
  getPovExecution(roomId: string, submissionId: string): Promise<CommandPovExecution | undefined>;
  compareAndSetPovExecution(expectedUpdatedAt: string, execution: CommandPovExecution): Promise<{ readonly kind: "accepted"; readonly execution: CommandPovExecution } | { readonly kind: "conflict" | "not-found" }>;
  getGhExecution(roomId: string, submissionId: string): Promise<CommandGhExecution | undefined>;
  createGhExecution(execution: CommandGhExecution): Promise<{ readonly kind: "created" | "duplicate"; readonly execution: CommandGhExecution }>;
  listPendingGhExecutions(roomId: string): Promise<readonly CommandGhExecution[]>;
  adoptGhAuthorizationLease(roomId: string, executionId: string, expectedUpdatedAt: string, authorizationLease: string, updatedAt: string): Promise<{ readonly kind: "accepted"; readonly execution: CommandGhExecution } | { readonly kind: "conflict" | "not-found" }>;
  compareAndSetGhExecution(expectedUpdatedAt: string, execution: CommandGhExecution): Promise<{ readonly kind: "accepted"; readonly execution: CommandGhExecution } | { readonly kind: "conflict" | "not-found" }>;
  markGhExecutionDelivered(roomId: string, executionId: string, expectedUpdatedAt: string, updatedAt: string): Promise<{ readonly kind: "accepted"; readonly execution: CommandGhExecution } | { readonly kind: "conflict" | "not-found" }>;
  appendDiagnostic(record: DiagnosticRecord): Promise<{ readonly kind: "created" | "duplicate"; readonly record: DiagnosticRecord }>;
  getDiagnostic(roomId: string, agentId: ActiveAgentId, recordId: string): Promise<DiagnosticRecord | undefined>;
  listDiagnostics(roomId: string, query: ActiveAgentId | DiagnosticQuery, limit?: number): Promise<readonly DiagnosticRecord[]>;
  compactCommandRecords(roomId:string,now:string):Promise<void>;
}

import type { ActiveAgentId } from "../shared/participants.js";
import type { CommandInvocation, RoomCommandName } from "../shared/command-domain.js";

export type CommandInvoker = { readonly kind: "human" | "agent"; readonly id: string; readonly displayName: string };
export interface CommandSubmission { readonly submissionId: string; readonly roomId: string; readonly clientSubmissionId: string; readonly command: RoomCommandName; readonly invocation: CommandInvocation; readonly invoker: CommandInvoker; readonly createdAt: string }
export interface RoundRobinState { readonly roomId: string; readonly lastAssignedAgentId: ActiveAgentId | null; readonly revision: number; readonly updatedAt: string }
export interface CommandAttempt { readonly attemptId: string; readonly roomId: string; readonly submissionId: string; readonly attempt: number; readonly agentId: ActiveAgentId; readonly generationId: string | null; readonly status: "queued" | "active" | "completed" | "failed" | "superseded"; readonly reason: string | null; readonly createdAt: string; readonly updatedAt: string }
export interface CommandPoll { readonly pollId: string; readonly roomId: string; readonly submissionId: string; readonly question: string; readonly options: readonly [string, string, ...string[]]; readonly createdAt: string }
export interface CommandVote { readonly roomId: string; readonly pollId: string; readonly voterId: string; readonly optionIndex: number; readonly createdAt: string }
export interface CommandAuditIdentity { readonly auditId: string; readonly roomId: string; readonly submissionId: string; readonly command: RoomCommandName; readonly invokerKind: CommandInvoker["kind"]; readonly invokerId: string; readonly targetAgentIds: readonly ActiveAgentId[]; readonly createdAt: string }
export interface DiagnosticRecord { readonly recordId: string; readonly roomId: string; readonly agentId: ActiveAgentId; readonly attemptId: string; readonly generationId: string | null; readonly correlationId: string; readonly promptHead: string | null; readonly promptFingerprint: string; readonly reason: string; readonly metadata: Readonly<Record<string, string | number | boolean | null>>; readonly diagnosticText: string | null; readonly createdAt: string }

/** Deliberately returned only from authenticated command/diagnostic endpoints. */
export interface PrivateCommandProjection { readonly submission: CommandSubmission; readonly attempts: readonly CommandAttempt[]; readonly audit: CommandAuditIdentity | null; readonly diagnostics: readonly DiagnosticRecord[] }
/** Safe poll card projection; invocation text, audit identity, and diagnostics are excluded. */
export interface PublicPollProjection { readonly pollId: string; readonly question: string; readonly options: readonly string[]; readonly tallies: readonly number[]; readonly totalVotes: number }

export function publicPollProjection(poll: CommandPoll, votes: readonly CommandVote[]): PublicPollProjection {
  const scoped = votes.filter((vote) => vote.roomId === poll.roomId && vote.pollId === poll.pollId && vote.optionIndex < poll.options.length);
  return { pollId: poll.pollId, question: poll.question, options: [...poll.options], tallies: poll.options.map((_, index) => scoped.filter((vote) => vote.optionIndex === index).length), totalVotes: scoped.length };
}

export const MAX_DIAGNOSTIC_TEXT = 2_000;
export const MAX_DIAGNOSTIC_PROMPT_HEAD = 300;
export const MAX_DIAGNOSTICS_PER_ROOM_AGENT = 200;
export const MAX_DIAGNOSTIC_QUERY_LIMIT = 200;
export const MAX_DIAGNOSTIC_SEARCH_LENGTH = 200;
export const DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface DiagnosticQuery {
  readonly agentId: ActiveAgentId;
  readonly limit?: number;
  readonly search?: string;
  readonly reason?: string;
}

export type CreateCommandSubmissionResult = { readonly kind: "created"; readonly submission: CommandSubmission } | { readonly kind: "duplicate"; readonly submission: CommandSubmission };
export type CreateCommandVoteResult = { readonly kind: "created"; readonly vote: CommandVote } | { readonly kind: "duplicate"; readonly vote: CommandVote } | { readonly kind: "rejected"; readonly reason: string };
export interface CommandAcceptance {
  readonly submission: CommandSubmission;
  readonly audit: CommandAuditIdentity;
  readonly poll?: CommandPoll;
  readonly attempt?: CommandAttempt;
  readonly roundRobin?: { readonly expectedRevision: number; readonly state: RoundRobinState };
}
export type AcceptCommandResult =
  | { readonly kind: "accepted"; readonly acceptance: CommandAcceptance }
  | { readonly kind: "duplicate"; readonly submission: CommandSubmission }
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
  listCommandPolls(roomId: string): Promise<readonly CommandPoll[]>;
  getCommandPoll(roomId: string, pollId: string): Promise<CommandPoll | undefined>;
  createCommandVote(vote: CommandVote): Promise<CreateCommandVoteResult>;
  listCommandVotes(roomId: string, pollId: string): Promise<readonly CommandVote[]>;
  createCommandAuditIdentity(audit: CommandAuditIdentity): Promise<{ readonly kind: "created" | "duplicate"; readonly audit: CommandAuditIdentity }>;
  getCommandAuditIdentity(roomId: string, submissionId: string): Promise<CommandAuditIdentity | undefined>;
  listCommandAuditIdentities(roomId: string): Promise<readonly CommandAuditIdentity[]>;
  appendDiagnostic(record: DiagnosticRecord): Promise<{ readonly kind: "created" | "duplicate"; readonly record: DiagnosticRecord }>;
  getDiagnostic(roomId: string, agentId: ActiveAgentId, recordId: string): Promise<DiagnosticRecord | undefined>;
  listDiagnostics(roomId: string, query: ActiveAgentId | DiagnosticQuery, limit?: number): Promise<readonly DiagnosticRecord[]>;
}

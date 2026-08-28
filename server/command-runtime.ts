import { createHash } from "node:crypto";
import { effectiveAllowedCommands, normalizeCommandPermissions, parseCommandInput, resolveRoundRobin, ROOM_COMMANDS, type CommandInput, type CommandInvocation, type RoomCommandName } from "../shared/command-domain.js";
import { isActiveAgentId, type ActiveAgentId } from "../shared/participants.js";
import { normalizeRoomAgentRoster, resolveRoomAgentTarget, resolveRoomAgentTargetPrefix, roomAgentEntry, type RoomAgentRoster } from "../shared/roster.js";
import { redactDiagnosticSecrets } from "../shared/diagnostic-redaction.js";
import { CANONICAL_ROOM_ID } from "./storage/room-repository.js";
import { MAX_COMMAND_DELIVERY_MESSAGE, MAX_DIAGNOSTIC_PROMPT_HEAD, MAX_DIAGNOSTIC_TEXT, publicPollProjection, type CommandAttempt, type CommandGhExecution, type CommandInvoker, type CommandPoll, type CommandPovExecution, type CommandRecordStore, type CommandSubmission, type DiagnosticRecord, type GhProjection, type PublicPollProjection } from "./command-record.js";
import type { GitHubReadService } from "./github-read-service.js";
import type { GitHubEndpointFamily, GitHubFailureKind } from "./github-read-adapter.js";

export const DEFAULT_COMMAND_STAGE_1_MS = 12_000;
export const DEFAULT_COMMAND_STAGE_2_MS = 75_000;
export const MAX_COMMAND_ATTEMPTS = 32;

export interface CommandClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: CommandClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer; },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CommandExecutionResult {
  readonly generationId?: string;
  readonly visibleMessages?: readonly string[];
  readonly rawText?: string;
  readonly diagnosticText?: string;
  readonly sessionId?: string;
  readonly permission?: "read-only" | "writable";
  readonly codeEpoch?: string;
  readonly cursorMessageId?: string;
}

export interface CommandLaunchHooks {
  active(generationId: string): Promise<boolean>;
  partial(text: string): void;
  readonly signal: AbortSignal;
}

export interface CommandRuntimeDependencies {
  readonly store: CommandRecordStore;
  readonly roster: () => RoomAgentRoster;
  readonly canLaunch: (agentId: ActiveAgentId) => boolean | Promise<boolean>;
  readonly reserveLaunch?: (agentId: ActiveAgentId) => { release(): unknown; activate?(generationId:string):unknown } | undefined;
  readonly roomEpoch?: () => string;
  readonly roomEpochCurrent?: (epoch: string) => boolean;
  readonly executeTask: (agentId: ActiveAgentId, prompt: string, hooks: CommandLaunchHooks) => Promise<CommandExecutionResult>;
  readonly executePov: (agentId: ActiveAgentId, prompt: string, signal: AbortSignal) => Promise<CommandExecutionResult>;
  readonly deliverPov: (executionId:string,agentId:ActiveAgentId,messages:readonly string[],result:CommandExecutionResult)=>Promise<void>;
  readonly publishStatus: (auditId: string, text: string) => Promise<void>;
  readonly deliverTask: (attemptId: string, agentId: ActiveAgentId, messages: readonly string[], result: CommandExecutionResult) => Promise<void>;
  readonly githubRead?: GitHubReadService;
  readonly publishGhResult?: (executionId:string,text:string)=>Promise<void>;
  readonly ceiling?: readonly RoomCommandName[];
  readonly roomId?: string;
  readonly clock?: CommandClock;
  readonly stage1Ms?: number;
  readonly stage2Ms?: number;
  readonly capabilityAudit?: (event: { agentId: string; capability: "github_read"; outcome: "attempted" | "allowed" | "denied" | "failed" | "completed"; correlationId?: string; reason?: string }) => Promise<unknown>;
  readonly operationLog?: (level: "info" | "error", event: string, fields: Record<string, unknown>) => Promise<unknown> | unknown;
}

export type CommandResponse =
  | { readonly kind: "private-error"; readonly message: string }
  | { readonly kind: "private-help"; readonly commands: readonly RoomCommandName[]; readonly submissionId: string; readonly duplicate: boolean }
  | { readonly kind: "accepted"; readonly submissionId: string; readonly duplicate: boolean; readonly poll?: PublicPollProjection; readonly github?: GhProjection; readonly resultText?: string };

interface LiveAttempt { readonly controller: AbortController; readonly reservation?: { release(): unknown; activate?(generationId:string):unknown }; partial: string; timer?: unknown }
class PovDeliveryPendingError extends Error {}

function boundedDelay(value: number | undefined, fallback: number, minimum: number, maximum: number) { return value === undefined ? fallback : Math.max(minimum, Math.min(maximum, Math.floor(value))); }
function stableId(...parts: string[]) { return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32); }
function timestamp(clock: CommandClock, after?: string) { const now = clock.now(); const previous = after ? Date.parse(after) : Number.NaN; return new Date(Number.isFinite(previous) ? Math.max(now, previous + 1) : now).toISOString(); }
function safeLabel(value: string) { return value.replace(/[\r\n\t]+/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "participant"; }
function ghEndpointFamily(submission:CommandSubmission):GitHubEndpointFamily{const selector=(submission.invocation as Extract<CommandInvocation,{command:"gh"}>).selector;if(selector.kind==="pr")return"pull-request";if(selector.kind==="issue")return"issue";if(selector.kind==="ci")return selector.number===undefined?"recent-runs":"pull-request";return"recent-pulls";}
function promptFingerprint(prompt: string) { return `sha256:${createHash("sha256").update(prompt).digest("hex")}`; }
function durableDeliveryResult(result: CommandExecutionResult) { return { ...(result.sessionId?{sessionId:result.sessionId.slice(0,500)}:{}), ...(result.permission?{permission:result.permission}:{}), ...(result.codeEpoch?{codeEpoch:result.codeEpoch.slice(0,500)}:{}), ...(result.cursorMessageId?{cursorMessageId:result.cursorMessageId.slice(0,500)}:{}) }; }
export function sanitizeDiagnosticText(input: string | undefined) {
  if (!input) return null;
  const sanitized = redactDiagnosticSecrets(input).trim();
  return sanitized ? sanitized.slice(0, MAX_DIAGNOSTIC_TEXT) : null;
}

export class CommandRuntime {
  private readonly roomId: string;
  private readonly clock: CommandClock;
  private readonly stage1Ms: number;
  private readonly stage2Ms: number;
  private readonly ceiling: readonly RoomCommandName[];
  private readonly live = new Map<string, LiveAttempt>();
  private readonly livePov = new Map<string, AbortController>();
  private readonly recoveredQueued = new Map<string,{attempt:CommandAttempt;submission:CommandSubmission;timer?:unknown}>();
  private closing=false;

  constructor(private readonly dependencies: CommandRuntimeDependencies) {
    this.roomId = dependencies.roomId || CANONICAL_ROOM_ID;
    this.clock = dependencies.clock || systemClock;
    this.stage1Ms = boundedDelay(dependencies.stage1Ms, DEFAULT_COMMAND_STAGE_1_MS, 1, 60_000);
    this.stage2Ms = boundedDelay(dependencies.stage2Ms, DEFAULT_COMMAND_STAGE_2_MS, 1, 300_000);
    this.ceiling = dependencies.ceiling || ROOM_COMMANDS;
  }

  async initialize() {
    for (const audit of await this.dependencies.store.listCommandAuditIdentities(this.roomId)) {
      const submission=await this.dependencies.store.getCommandSubmission(this.roomId,audit.submissionId); if(submission)await this.publishAuditObserved(submission,audit);
    }
    for (const attempt of await this.dependencies.store.listPendingCommandAttempts(this.roomId)) {
      const submission = await this.dependencies.store.getCommandSubmission(this.roomId, attempt.submissionId);
      if (!submission || submission.invocation.command !== "task") continue;
      if (attempt.status === "delivery-pending") await this.resumeDelivery(attempt, submission);
      else if(attempt.status==="queued")await this.launch(submission,attempt.agentId,attempt.attempt,attempt,true);
      else this.armRecovered(attempt, submission);
    }
    for(const execution of await this.dependencies.store.listPendingPovExecutions(this.roomId)){const submission=await this.dependencies.store.getCommandSubmission(this.roomId,execution.submissionId);if(submission?.invocation.command==="pov")this.startPov(execution,submission);}
    for(const execution of await this.dependencies.store.listPendingGhExecutions(this.roomId)){const submission=await this.dependencies.store.getCommandSubmission(this.roomId,execution.submissionId);if(submission?.invocation.command==="gh")await (execution.status==="queued"?this.executeGh(execution,submission):this.deliverGhResult(execution)).catch(()=>undefined);}
    for(const poll of await this.dependencies.store.listCommandPolls(this.roomId,{limit:100,state:"CLOSED"}))await this.publishPollClosed(poll);
  }

  async close() {
    this.closing=true;
    for (const [attemptId, live] of this.live) {
      if (live.timer) this.clock.clearTimeout(live.timer);
      live.controller.abort();
      live.reservation?.release();
      this.live.delete(attemptId);
    }
    for(const recovered of this.recoveredQueued.values())if(recovered.timer)this.clock.clearTimeout(recovered.timer);
    this.recoveredQueued.clear();
    const terminal:Promise<unknown>[]=[];
    for(const [executionId,controller] of this.livePov){controller.abort();this.livePov.delete(executionId);}
    for(const execution of await this.dependencies.store.listPendingPovExecutions(this.roomId))if(!execution.currentTargetAgentId)terminal.push(this.finishPov(execution.executionId,"cancelled","server shutdown cancelled POV execution"));
    await Promise.all(terminal);
  }

  async submit(input: CommandInput, invoker: CommandInvoker, clientSubmissionId: string): Promise<CommandResponse> {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(clientSubmissionId)) return { kind: "private-error", message: "A valid command request ID is required." };
    await this.dependencies.store.compactCommandRecords(this.roomId,timestamp(this.clock));
    const parsed = this.parseInput(input);
    if (parsed.kind !== "command") return parsed.kind === "private-error" ? parsed : { kind: "private-error", message: "No command was provided." };
    if(parsed.invocation.command==="gh")this.reportCapability({agentId:invoker.id,capability:"github_read",outcome:"attempted",correlationId:clientSubmissionId});
    const allowed = this.allowed(invoker);
    if (!allowed.includes(parsed.invocation.command)) { if(parsed.invocation.command==="gh")this.reportCapability({agentId:invoker.id,capability:"github_read",outcome:"denied",reason:"permission-not-granted"}); return { kind: "private-error", message: "That command is not available to this participant." }; }
    const canonical = this.canonicalInvocation(parsed.invocation);
    if (canonical.kind === "private-error") return canonical;
    const createdAt = timestamp(this.clock);
    const submission: CommandSubmission = { submissionId: stableId(this.roomId, invoker.kind, invoker.id, clientSubmissionId), roomId: this.roomId, clientSubmissionId, command: canonical.invocation.command, invocation: canonical.invocation, invoker, createdAt };
    return this.dispatch(submission);
  }

  async listOpenPolls(invoker: CommandInvoker) {
    if (!await this.pollAuthorized(invoker)) return { kind:"private-error" as const,message:"Poll access is not available to this participant." };
    const polls=await this.dependencies.store.listCommandPolls(this.roomId,{limit:20,state:"OPEN"});
    return {kind:"polls" as const,items:await Promise.all(polls.map(async(poll)=>publicPollProjection(poll,await this.dependencies.store.listCommandVotes(this.roomId,poll.pollId),{kind:invoker.kind,id:invoker.id})))};
  }

  async vote(pollId: string, invoker: CommandInvoker, mutationId: string, optionIndex: number) {
    if (!await this.pollAuthorized(invoker) || !/^[a-zA-Z0-9:_-]{8,100}$/.test(mutationId) || !Number.isSafeInteger(optionIndex) || optionIndex < 0) return { kind: "private-error" as const, message: "A valid poll choice and request ID are required." };
    const voterId=`${invoker.kind}:${invoker.id}`;
    const vote = await this.dependencies.store.createCommandVote({ roomId: this.roomId, pollId, voterId, mutationId, optionIndex, createdAt: timestamp(this.clock) });
    if (vote.kind === "rejected") return { kind: "private-error" as const, message: vote.reason };
    const poll = await this.dependencies.store.getCommandPoll(this.roomId, pollId);
    if (!poll) return { kind: "private-error" as const, message: "Poll not found." };
    return { kind: "accepted" as const, duplicate: vote.kind === "duplicate", poll: publicPollProjection(poll, await this.dependencies.store.listCommandVotes(this.roomId, pollId),{kind:invoker.kind,id:invoker.id}) };
  }

  async closePoll(pollId:string,invoker:CommandInvoker|{kind:"controller";id:string;displayName:string},mutationId:string,expectedRevision:number){
    if(!/^[a-zA-Z0-9:_-]{8,100}$/.test(mutationId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)return{kind:"private-error" as const,message:"A valid close request and poll revision are required."};
    const poll=await this.dependencies.store.getCommandPoll(this.roomId,pollId);if(!poll)return{kind:"private-error" as const,message:"Poll not found."};
    const creator=invoker.kind===poll.creatorKind&&invoker.id===poll.creatorId;const controller=invoker.kind==="controller";
    if(!controller&&(!creator||!await this.pollAuthorized(invoker)))return{kind:"private-error" as const,message:"Only the poll creator or a room controller can end this poll."};
    const result=await this.dependencies.store.closeCommandPoll({roomId:this.roomId,pollId,expectedRevision,mutationId,closerKind:invoker.kind,closerId:invoker.id,closedAt:timestamp(this.clock)});
    if(result.kind==="rejected"||result.kind==="not-found")return{kind:"private-error" as const,message:result.reason};
    if(result.kind==="conflict")return{kind:"private-error" as const,message:"The poll changed; refresh before ending it."};
    if(result.kind!=="closed"&&result.kind!=="duplicate")return{kind:"private-error" as const,message:"The poll could not be ended."};
    await this.publishPollClosed(result.poll);
    return{kind:"accepted" as const,duplicate:result.kind==="duplicate",poll:publicPollProjection(result.poll,await this.dependencies.store.listCommandVotes(this.roomId,pollId),{kind:invoker.kind,id:invoker.id,canControl:controller})};
  }

  async captureDiagnostic(input: { agentId: ActiveAgentId; attemptId: string; generationId?: string; correlationId: string; prompt: string; reason: string; text?: string; metadata?: DiagnosticRecord["metadata"] }) {
    const record: DiagnosticRecord = { recordId: stableId(this.roomId,input.correlationId), roomId: this.roomId, agentId: input.agentId, attemptId: input.attemptId, generationId: input.generationId || null, correlationId: input.correlationId.slice(0,500), promptHead: null, promptFingerprint: promptFingerprint(input.prompt), reason: safeLabel(input.reason), metadata: input.metadata || {}, diagnosticText: sanitizeDiagnosticText(input.text), createdAt: timestamp(this.clock) };
    return this.dependencies.store.appendDiagnostic(record);
  }
  async getGhDiagnostic(invoker:CommandInvoker,submissionId:string){if(!this.allowed(invoker).includes("gh"))return{kind:"private-error" as const,message:"GitHub diagnostics are not available to this participant."};const submission=await this.dependencies.store.getCommandSubmission(this.roomId,submissionId);if(!submission||submission.command!=="gh"||submission.invoker.kind!==invoker.kind||submission.invoker.id!==invoker.id)return{kind:"private-error" as const,message:"GitHub diagnostic record not found."};const execution=await this.dependencies.store.getGhExecution(this.roomId,submissionId);return execution?{kind:"github-diagnostic" as const,submissionId,status:execution.status,items:execution.diagnostics}:{kind:"private-error" as const,message:"GitHub diagnostic record not found."};}

  private allowed(invoker: CommandInvoker) {
    if (invoker.kind === "human") return [...this.ceiling];
    if (!isActiveAgentId(invoker.id)) return [];
    const entry = roomAgentEntry(this.dependencies.roster(), invoker.id);
    return entry?.enabled ? effectiveAllowedCommands(normalizeCommandPermissions(entry.commandPermissions), this.ceiling) : [];
  }

  private pollAuthorized(invoker:CommandInvoker){return invoker.kind==="human"||isActiveAgentId(invoker.id)&&this.allowed(invoker).includes("poll")&&Boolean(roomAgentEntry(this.dependencies.roster(),invoker.id)?.enabled);}
  private parseInput(input:CommandInput){
    if(typeof input!=="string")return parseCommandInput(input);
    const match=/^\s*\/pov\s+(@[\s\S]+)$/.exec(input);
    if(!match)return parseCommandInput(input);
    const target=resolveRoomAgentTargetPrefix(this.dependencies.roster(),match[1]!);
    if(target.kind==="ambiguous")return{kind:"private-error" as const,message:"That participant name is ambiguous; choose the exact roster mention."};
    return target.kind==="resolved"
      ? parseCommandInput({command:"pov",prompt:target.rest,selection:{kind:"pinned",agentId:target.agentId}})
      : parseCommandInput(input);
  }
  private canonicalInvocation(invocation:CommandInvocation):{kind:"command";invocation:CommandInvocation}|{kind:"private-error";message:string}{
    if((invocation.command!=="task"&&invocation.command!=="pov")||invocation.selection.kind!=="pinned")return{kind:"command",invocation};
    const resolved=resolveRoomAgentTarget(this.dependencies.roster(),invocation.selection.agentId);
    if(resolved.kind!=="resolved")return{kind:"private-error",message:resolved.kind==="ambiguous"?"That participant name is ambiguous; choose the exact roster mention.":"That participant is not in the room roster."};
    return{kind:"command",invocation:{...invocation,selection:{kind:"pinned",agentId:resolved.agentId}} as CommandInvocation};
  }

  private async replay(submission: CommandSubmission): Promise<CommandResponse> {
    const audit=await this.dependencies.store.getCommandAuditIdentity(this.roomId,submission.submissionId);if(!audit)return{kind:"private-error",message:"The original command was not accepted."};await this.resumeAcceptedWork(submission);await this.publishAuditObserved(submission,audit);
    if (submission.command === "help") return { kind: "private-help", commands: this.allowed(submission.invoker), submissionId: submission.submissionId, duplicate: true };
    if (submission.command === "poll") {
      const poll = await this.dependencies.store.getCommandPoll(this.roomId, stableId(submission.submissionId,"poll"));
      if (poll) return { kind: "accepted", submissionId: submission.submissionId, duplicate: true, poll: publicPollProjection(poll, await this.dependencies.store.listCommandVotes(this.roomId,poll.pollId)) };
    }
    if(submission.command==="gh"){const execution=await this.dependencies.store.getGhExecution(this.roomId,submission.submissionId);if(!execution)return{kind:"private-error",message:"The original GitHub command is still being recovered."};if(execution.status==="queued")return this.executeGh(execution,submission,true);await this.deliverGhResult(execution).catch(()=>undefined);return{kind:"accepted",submissionId:submission.submissionId,duplicate:true,...(execution.projection?{github:execution.projection}:{}),...(execution.renderedText?{resultText:execution.renderedText}:{})};}
    return { kind: "accepted", submissionId: submission.submissionId, duplicate: true };
  }

  private async dispatch(submission: CommandSubmission): Promise<CommandResponse> {
    const invocation = submission.invocation;
    if (invocation.command === "help") {
      if (!this.authorized(submission)) return { kind: "private-error", message: "Command permission changed before dispatch." };
      const audit = this.auditRecord(submission, []);
      const accepted = await this.dependencies.store.acceptCommand({ submission, audit });
      if (accepted.kind === "duplicate") return this.replay(accepted.submission);
      if (accepted.kind === "compacted-duplicate") return { kind: "private-help", commands: this.allowed(submission.invoker), submissionId: accepted.tombstone.submissionId, duplicate: true };
      if (accepted.kind === "conflict") throw new Error("Unexpected help acceptance conflict.");
      return { kind: "private-help", commands: this.allowed(submission.invoker), submissionId: submission.submissionId, duplicate: false };
    }
    if (invocation.command === "poll") {
      if(!this.authorized(submission))return{kind:"private-error",message:"Command permission changed before dispatch."};
      const poll:CommandPoll={ pollId: stableId(submission.submissionId,"poll"), roomId: this.roomId, submissionId: submission.submissionId, question: invocation.question, options: invocation.options, creatorKind:submission.invoker.kind,creatorId:submission.invoker.id,state:"OPEN",revision:1,closedAt:null,closerKind:null,closerId:null,closeMutationId:null,finalTallies:null,finalTotalVotes:null,createdAt: submission.createdAt };
      const audit=this.auditRecord(submission,[]); const accepted=await this.dependencies.store.acceptCommand({submission,audit,poll});
      if(accepted.kind==="duplicate")return this.replay(accepted.submission);if(accepted.kind==="compacted-duplicate")return{kind:"accepted",submissionId:accepted.tombstone.submissionId,duplicate:true};if(accepted.kind==="rejected")return{kind:"private-error",message:accepted.reason};if(accepted.kind==="conflict")throw new Error("Unexpected poll acceptance conflict."); await this.publishAuditObserved(submission,audit);
      return { kind: "accepted", submissionId: submission.submissionId, duplicate: false, poll: publicPollProjection(poll,[]) };
    }
    if (invocation.command === "pov") {
      const targets = invocation.selection.kind==="pinned"?(await this.launchEligible(submission,invocation.selection.agentId)?[invocation.selection.agentId]:[]):await this.eligibleAgents("pov");
      if (!targets.length) return { kind: "private-error", message: "No eligible participants are available." };
      if(!this.authorized(submission))return{kind:"private-error",message:"Command permission changed before dispatch."};
      const now=timestamp(this.clock);const povExecution:CommandPovExecution={executionId:stableId(submission.submissionId,"pov-execution"),roomId:this.roomId,submissionId:submission.submissionId,targetAgentIds:targets,processedTargetAgentIds:[],status:"queued",reason:null,createdAt:now,updatedAt:now};
      const audit=this.auditRecord(submission,targets); const accepted=await this.dependencies.store.acceptCommand({submission,audit,povExecution}); if(accepted.kind==="duplicate")return this.replay(accepted.submission);if(accepted.kind==="compacted-duplicate")return{kind:"accepted",submissionId:accepted.tombstone.submissionId,duplicate:true}; if(accepted.kind==="conflict")throw new Error("Unexpected POV acceptance conflict."); this.startPov(povExecution,submission);await this.publishAuditObserved(submission,audit);
      return { kind: "accepted", submissionId: submission.submissionId, duplicate: false };
    }
    if(invocation.command==="gh"){
      if(!this.dependencies.githubRead||!this.dependencies.publishGhResult){this.reportCapability({agentId:submission.invoker.id,capability:"github_read",outcome:"denied",correlationId:submission.submissionId,reason:"missing-server-config"});return{kind:"private-error",message:"GitHub reads are not configured."};}
      if(!this.authorized(submission)){this.reportCapability({agentId:submission.invoker.id,capability:"github_read",outcome:"denied",correlationId:submission.submissionId,reason:"permission-not-granted"});return{kind:"private-error",message:"Command permission changed before dispatch."};}
      this.reportCapability({agentId:submission.invoker.id,capability:"github_read",outcome:"allowed",correlationId:submission.submissionId});
      const now=timestamp(this.clock);const execution:CommandGhExecution={executionId:stableId(submission.submissionId,"gh-execution"),roomId:this.roomId,submissionId:submission.submissionId,status:"queued",deliveryStatus:"pending",projection:null,renderedText:null,failureKind:null,diagnostics:[],createdAt:now,updatedAt:now};const audit=this.auditRecord(submission,[]);const accepted=await this.dependencies.store.acceptCommand({submission,audit,ghExecution:execution});if(accepted.kind==="duplicate")return this.replay(accepted.submission);if(accepted.kind==="compacted-duplicate")return{kind:"accepted",submissionId:accepted.tombstone.submissionId,duplicate:true};if(accepted.kind==="conflict")throw new Error("Unexpected GitHub acceptance conflict.");await this.dependencies.store.createGhExecution(execution);await this.publishAuditObserved(submission,audit);return this.executeGh(execution,submission,false);
    }
    if (invocation.command !== "task") return { kind: "private-error", message: "Unsupported command." };
    for(let conflicts=0;conflicts<MAX_COMMAND_ATTEMPTS;conflicts++){
      const roster=normalizeRoomAgentRoster(this.dependencies.roster()); const candidates=await Promise.all(roster.entries.map(async(entry)=>({agentId:entry.agentId,eligible:entry.enabled&&await this.dependencies.canLaunch(entry.agentId)}))); const pointer=await this.dependencies.store.getRoundRobinState(this.roomId); const resolution=resolveRoundRobin(candidates,pointer.lastAssignedAgentId,invocation.selection.kind==="pinned"?invocation.selection.agentId:undefined); if(resolution.kind!=="selected")return{kind:"private-error",message:"No eligible participants are available."}; if(!this.authorized(submission))return{kind:"private-error",message:"Command permission changed before dispatch."};
      const now=timestamp(this.clock); const attempt:CommandAttempt={attemptId:stableId(submission.submissionId,"attempt","1"),roomId:this.roomId,submissionId:submission.submissionId,attempt:1,agentId:resolution.agentId,generationId:null,status:"queued",reason:null,...this.captureEpoch(resolution.agentId),createdAt:now,updatedAt:now}; const audit=this.auditRecord(submission,[resolution.agentId]); const roundRobin=resolution.advancePointer?{expectedRevision:pointer.revision,state:{roomId:this.roomId,lastAssignedAgentId:resolution.nextLastAssignedAgentId,revision:pointer.revision+1,updatedAt:timestamp(this.clock,pointer.updatedAt)}}:undefined; const accepted=await this.dependencies.store.acceptCommand({submission,audit,attempt,...(roundRobin?{roundRobin}:{})}); if(accepted.kind==="conflict")continue; if(accepted.kind==="duplicate")return this.replay(accepted.submission);if(accepted.kind==="compacted-duplicate")return{kind:"accepted",submissionId:accepted.tombstone.submissionId,duplicate:true}; await this.launch(submission,resolution.agentId,1,attempt);await this.publishAuditObserved(submission,audit); return{kind:"accepted",submissionId:submission.submissionId,duplicate:false};
    }
    return{kind:"private-error",message:"Command assignment changed too many times; try again."};
  }

  private authorized(submission:CommandSubmission){return this.allowed(submission.invoker).includes(submission.command);}
  private auditRecord(submission:CommandSubmission,targets:readonly ActiveAgentId[]){return{auditId:stableId(submission.submissionId,"audit"),roomId:this.roomId,submissionId:submission.submissionId,command:submission.command,invokerKind:submission.invoker.kind,invokerId:submission.invoker.id,targetAgentIds:targets,createdAt:timestamp(this.clock)} as const;}
  private async publishAudit(submission:CommandSubmission,audit:import("./command-record.js").CommandAuditIdentity){let text=this.auditText(submission,audit.targetAgentIds);if(submission.command==="poll"){const invocation=submission.invocation as Extract<CommandInvocation,{command:"poll"}>;text=`— ${safeLabel(submission.invoker.displayName)} ran /poll — Options: ${invocation.options.map((option,index)=>`${index+1}. ${safeLabel(option)}`).join(" · ")}`;}else if(submission.command==="gh")text=`— ${safeLabel(submission.invoker.displayName)} ran /gh — Read-only repository query`;await this.dependencies.publishStatus(audit.auditId,text);}
  private reportCapability(event:{agentId:string;capability:"github_read";outcome:"attempted"|"allowed"|"denied"|"failed"|"completed";correlationId?:string;reason?:string}){try{void Promise.resolve(this.dependencies.capabilityAudit?.(event)).catch(()=>undefined);}catch{}}
  private reportOperation(level:"info"|"error",event:string,fields:Record<string,unknown>){try{void Promise.resolve(this.dependencies.operationLog?.(level,event,fields)).catch(()=>undefined);}catch{}}
  private async publishAuditObserved(submission:CommandSubmission,audit:import("./command-record.js").CommandAuditIdentity){if(submission.command==="help")return;try{await this.publishAudit(submission,audit);}catch(error){this.reportOperation("error","command.audit-publication.failed",{error,outcome:"failed",reason:"durable-recovery-will-retry"});}}
  private async publishPollClosed(poll:CommandPoll){if(poll.state!=="CLOSED"||!poll.finalTallies)return;const summary=poll.options.map((option,index)=>`${safeLabel(option)}: ${poll.finalTallies![index]||0}`).join(" · ");try{await this.dependencies.publishStatus(`poll-closed:${poll.pollId}`,`— Poll closed — ${summary}`);}catch(error){this.reportOperation("error","command.poll-publication.failed",{error,outcome:"failed",reason:"durable-recovery-will-retry"});}}

  private async resumeAcceptedWork(submission: CommandSubmission) {
    if(submission.command==="gh"){const execution=await this.dependencies.store.getGhExecution(this.roomId,submission.submissionId);if(execution?.status==="queued")void this.executeGh(execution,submission);return;}
    if (submission.command === "pov") {
      const execution = await this.dependencies.store.getPovExecution(this.roomId, submission.submissionId);
      if (execution) this.startPov(execution, submission);
      return;
    }
    if (submission.command !== "task") return;
    const pending = (await this.dependencies.store.listCommandAttempts(this.roomId, submission.submissionId)).findLast((attempt) => attempt.status === "queued" || attempt.status === "delivery-pending");
    if (!pending || this.live.has(pending.attemptId)) return;
    if (pending.status === "delivery-pending") await this.resumeDelivery(pending, submission);
    else await this.launch(submission, pending.agentId, pending.attempt, pending);
  }

  private async executeGh(execution:CommandGhExecution,submission:CommandSubmission,duplicate=false):Promise<CommandResponse>{
    if(!this.authorized(submission))return this.terminalizeGh(execution,submission,"forbidden","GitHub command permission changed before recovery.");
    if(!this.dependencies.githubRead||!this.dependencies.publishGhResult)return this.terminalizeGh(execution,submission,"configuration","GitHub reads are no longer configured.");
    const current=await this.dependencies.store.getGhExecution(this.roomId,submission.submissionId);if(!current)return{kind:"private-error",message:"GitHub execution metadata is unavailable."};if(current.status!=="queued"){await this.deliverGhResult(current).catch(()=>undefined);return{kind:"accepted",submissionId:submission.submissionId,duplicate:true,...(current.projection?{github:current.projection}:{}),...(current.renderedText?{resultText:current.renderedText}:{})};}
    let terminal:CommandGhExecution;
    try{const result=await this.dependencies.githubRead.execute((submission.invocation as Extract<CommandInvocation,{command:"gh"}>).selector);terminal={...current,status:"completed",deliveryStatus:"pending",projection:result.projection,renderedText:result.renderedText,failureKind:null,diagnostics:result.diagnostics,updatedAt:timestamp(this.clock,current.updatedAt)};this.reportCapability({agentId:submission.invoker.id,capability:"github_read",outcome:"completed",correlationId:submission.submissionId});}
    catch(error){const failed=this.dependencies.githubRead.failure(error);terminal={...current,status:"failed",deliveryStatus:"pending",projection:null,renderedText:failed.text.slice(0,MAX_COMMAND_DELIVERY_MESSAGE),failureKind:failed.kind,diagnostics:[failed.diagnostic],updatedAt:timestamp(this.clock,current.updatedAt)};this.reportCapability({agentId:submission.invoker.id,capability:"github_read",outcome:"failed",correlationId:submission.submissionId,reason:failed.kind});}
    const saved=await this.dependencies.store.compareAndSetGhExecution(current.updatedAt,terminal);const durable=saved.kind==="accepted"?saved.execution:await this.dependencies.store.getGhExecution(this.roomId,submission.submissionId);if(!durable||durable.status==="queued")return{kind:"private-error",message:"GitHub execution changed concurrently; retry with the same request ID."};await this.deliverGhResult(durable).catch(()=>undefined);return{kind:"accepted",submissionId:submission.submissionId,duplicate,...(durable.projection?{github:durable.projection}:{}),...(durable.renderedText?{resultText:durable.renderedText}:{})};
  }

  private async deliverGhResult(execution:CommandGhExecution){if(execution.status==="queued"||execution.deliveryStatus==="delivered"||!execution.renderedText||!this.dependencies.publishGhResult)return;await this.dependencies.publishGhResult(execution.executionId,execution.renderedText);await this.dependencies.store.markGhExecutionDelivered(execution.roomId,execution.executionId,execution.updatedAt,timestamp(this.clock,execution.updatedAt));}

  private async terminalizeGh(execution:CommandGhExecution,submission:CommandSubmission,kind:GitHubFailureKind,text:string):Promise<CommandResponse>{if(execution.status!=="queued")return{kind:"accepted",submissionId:submission.submissionId,duplicate:true,...(execution.projection?{github:execution.projection}:{}),...(execution.renderedText?{resultText:execution.renderedText}:{})};const family=ghEndpointFamily(submission);const terminal:CommandGhExecution={...execution,status:"failed",deliveryStatus:"delivered",projection:null,renderedText:text.slice(0,MAX_COMMAND_DELIVERY_MESSAGE),failureKind:kind,diagnostics:[{endpointFamily:family,cacheOutcome:"miss",queueDelayMs:0,rateLimited:false,truncated:false,failureKind:kind,statusClass:"none",correlationId:`recovery:${kind}`}],updatedAt:timestamp(this.clock,execution.updatedAt)};const saved=await this.dependencies.store.compareAndSetGhExecution(execution.updatedAt,terminal);const durable=saved.kind==="accepted"?saved.execution:await this.dependencies.store.getGhExecution(this.roomId,submission.submissionId);return durable&&durable.status!=="queued"?{kind:"accepted",submissionId:submission.submissionId,duplicate:true,...(durable.renderedText?{resultText:durable.renderedText}:{}),...(durable.projection?{github:durable.projection}:{})}:{kind:"private-error",message:"GitHub recovery could not be finalized."};}

  private auditText(submission: CommandSubmission, targets: readonly ActiveAgentId[]) {
    const roster = normalizeRoomAgentRoster(this.dependencies.roster());
    const names = targets.map((agent) => safeLabel(roster.entries.find((entry)=>entry.agentId===agent)?.conversationalName || agent));
    return `— ${safeLabel(submission.invoker.displayName)} ran /${submission.command} — Target${names.length===1?"":"s"}: ${names.join(", ")}`;
  }

  private async eligibleAgents(_command: RoomCommandName, excluded = new Set<ActiveAgentId>()) {
    const roster = normalizeRoomAgentRoster(this.dependencies.roster());
    const result: ActiveAgentId[] = [];
    for (const entry of roster.entries) if (entry.enabled && !excluded.has(entry.agentId) && await this.dependencies.canLaunch(entry.agentId)) result.push(entry.agentId);
    return result;
  }

  private deferRecovered(attempt:CommandAttempt,submission:CommandSubmission){if(this.closing||this.recoveredQueued.has(attempt.attemptId))return;const recovered:{attempt:CommandAttempt;submission:CommandSubmission;timer?:unknown}={attempt,submission};recovered.timer=this.clock.setTimeout(()=>{this.recoveredQueued.delete(attempt.attemptId);void this.launch(submission,attempt.agentId,attempt.attempt,attempt,true);},Math.min(250,this.stage1Ms));this.recoveredQueued.set(attempt.attemptId,recovered);}
  private async launch(submission: CommandSubmission, agentId: ActiveAgentId, attemptNumber: number, acceptedAttempt?:CommandAttempt, recovered=false) {
    if (attemptNumber > MAX_COMMAND_ATTEMPTS) return;
    let attempt=acceptedAttempt;
    if(!attempt){const now=timestamp(this.clock);const created=await this.dependencies.store.createCommandAttempt({ attemptId: stableId(submission.submissionId,"attempt",String(attemptNumber)), roomId:this.roomId,submissionId:submission.submissionId,attempt:attemptNumber,agentId,generationId:null,status:"queued",reason:null,...this.captureEpoch(agentId),createdAt:now,updatedAt:now });if(created.kind==="duplicate"&&created.attempt.status!=="queued")return;attempt=created.attempt;}
    if (!await this.launchEligible(submission,agentId)){if(recovered&&this.agentCurrent(agentId)){this.deferRecovered(attempt,submission);return;}return this.failAndReassign(attempt,submission,"eligibility changed before launch");}
    const reservation=this.dependencies.reserveLaunch?.(agentId);
    if(this.dependencies.reserveLaunch&&!reservation){if(recovered){this.deferRecovered(attempt,submission);return;}return this.failAndReassign(attempt,submission,"shared generation capacity changed before launch");}
    this.recoveredQueued.delete(attempt.attemptId);
    const live: LiveAttempt = { controller:new AbortController(),partial:"",...(reservation?{reservation}:{}) };
    this.live.set(attempt.attemptId,live);
    live.timer = this.clock.setTimeout(()=>void this.stage1(attempt,submission),this.stage1Ms);
    void this.dependencies.executeTask(agentId,(submission.invocation as Extract<CommandInvocation,{command:"task"}>).prompt,{ signal:live.controller.signal, partial:(text)=>{ live.partial=sanitizeDiagnosticText(text)||""; void this.captureLateStallPartial(attempt,submission,live.partial); }, active:async (generationId)=>this.markActive(attempt,generationId,submission) }).then((result)=>this.complete(attempt,submission,result)).catch((error)=>this.fail(attempt,submission,error));
  }

  private async launchEligible(submission: CommandSubmission, agentId: ActiveAgentId) {
    const entry = roomAgentEntry(this.dependencies.roster(),agentId);
    return Boolean(entry?.enabled && await this.dependencies.canLaunch(agentId));
  }

  private async markActive(attempt: CommandAttempt,generationId:string,submission:CommandSubmission) {
    const live=this.live.get(attempt.attemptId); if (!live) return false;
    if (!this.agentCurrent(attempt.agentId)) { await this.stage1(attempt,submission,"eligibility changed at generation start"); return false; }
    const active={...attempt,generationId,status:"active" as const,updatedAt:timestamp(this.clock,attempt.updatedAt)};
    const claimed=await this.dependencies.store.compareAndSetCommandAttempt(attempt.updatedAt,active);
    if(claimed.kind!=="accepted") return false;
    if (live.timer) this.clock.clearTimeout(live.timer);
    if(live.reservation?.activate)live.reservation.activate(generationId);else live.reservation?.release();
    live.timer=this.clock.setTimeout(()=>void this.stage2(active,submission),this.stage2Ms);
    return true;
  }

  private async complete(attempt:CommandAttempt,submission:CommandSubmission,result:CommandExecutionResult) {
    const attempts=await this.dependencies.store.listCommandAttempts(this.roomId,submission.submissionId); const current=attempts.find((item)=>item.attemptId===attempt.attemptId); if(!current||!(current.status==="queued"||current.status==="active")) return;
    if(!this.attemptCurrent(current))return this.failAndReassign(current,submission,"room or roster authority changed before command completion");
    const visible=(result.visibleMessages||[]).filter(Boolean).slice(0,3).map((message)=>message.slice(0,MAX_COMMAND_DELIVERY_MESSAGE));
    const pending={...current,generationId:result.generationId||current.generationId,status:"delivery-pending" as const,deliveryMessages:visible,deliveryResult:durableDeliveryResult(result),updatedAt:timestamp(this.clock,current.updatedAt)};
    const claimed=await this.dependencies.store.compareAndSetCommandAttempt(current.updatedAt,pending);if(claimed.kind!=="accepted")return;this.clearLive(attempt.attemptId);await this.resumeDelivery(pending,submission,result);if(!visible.length)await this.captureDiagnostic({agentId:current.agentId,attemptId:current.attemptId,generationId:pending.generationId||undefined,correlationId:`${current.attemptId}:no-response`,prompt:(submission.invocation as Extract<CommandInvocation,{command:"task"}>).prompt,reason:"no-response-needed",text:result.diagnosticText||result.rawText,metadata:{visibleMessages:0}});
  }

  private async resumeDelivery(attempt:CommandAttempt,submission:CommandSubmission,result?:CommandExecutionResult){const messages=attempt.deliveryMessages||[];if(!this.attemptCurrent(attempt)){await this.captureDiagnostic({agentId:attempt.agentId,attemptId:attempt.attemptId,generationId:attempt.generationId||undefined,correlationId:`${attempt.attemptId}:authority-changed`,prompt:(submission.invocation as Extract<CommandInvocation,{command:"task"}>).prompt,reason:"authority-changed-before-delivery",text:messages.join("\n"),metadata:{visibleMessages:messages.length}});const dropped={...attempt,status:"completed" as const,updatedAt:timestamp(this.clock,attempt.updatedAt)};await this.dependencies.store.compareAndSetCommandAttempt(attempt.updatedAt,dropped);return;}await this.dependencies.deliverTask(attempt.attemptId,attempt.agentId,messages,result||{generationId:attempt.generationId||undefined,visibleMessages:messages,...attempt.deliveryResult});const completed={...attempt,status:"completed" as const,updatedAt:timestamp(this.clock,attempt.updatedAt)};await this.dependencies.store.compareAndSetCommandAttempt(attempt.updatedAt,completed);}

  private async fail(attempt:CommandAttempt,submission:CommandSubmission,error:unknown) { const attempts=await this.dependencies.store.listCommandAttempts(this.roomId,submission.submissionId); const current=attempts.find((item)=>item.attemptId===attempt.attemptId); if(!current||!(current.status==="queued"||current.status==="active")) return; await this.failAndReassign(current,submission,error instanceof Error?error.message:String(error)); }
  private async stage1(attempt:CommandAttempt,submission:CommandSubmission,reason="generation did not start before the launch watchdog") { await this.failAndReassign(attempt,submission,reason); }
  private async stage2(attempt:CommandAttempt,submission:CommandSubmission) { const live=this.live.get(attempt.attemptId); if(live?.partial) await this.captureDiagnostic({agentId:attempt.agentId,attemptId:attempt.attemptId,generationId:attempt.generationId||undefined,correlationId:`${attempt.attemptId}:stage-2`,prompt:(submission.invocation as Extract<CommandInvocation,{command:"task"}>).prompt,reason:"generation-stalled",text:live.partial,metadata:{stage:2}}); await this.failAndReassign(attempt,submission,"generation stalled before a terminal outcome"); }
  private async captureLateStallPartial(attempt:CommandAttempt,submission:CommandSubmission,text:string) { if(!text)return; const current=(await this.dependencies.store.listCommandAttempts(this.roomId,submission.submissionId)).find((item)=>item.attemptId===attempt.attemptId); if(current?.status!=="superseded"||!current.reason?.includes("stalled"))return; await this.captureDiagnostic({agentId:current.agentId,attemptId:current.attemptId,generationId:current.generationId||undefined,correlationId:`${current.attemptId}:stage-2`,prompt:(submission.invocation as Extract<CommandInvocation,{command:"task"}>).prompt,reason:"generation-stalled",text,metadata:{stage:2}}); }

  private async failAndReassign(attempt:CommandAttempt,submission:CommandSubmission,reason:string) {
    const attempts=await this.dependencies.store.listCommandAttempts(this.roomId,submission.submissionId); const current=attempts.find((item)=>item.attemptId===attempt.attemptId); if(!current||!(current.status==="queued"||current.status==="active")) return;
    const superseded={...current,status:"superseded" as const,reason:safeLabel(reason).slice(0,200),updatedAt:timestamp(this.clock,current.updatedAt)};
    this.clearLive(current.attemptId,true);
    const invocation=submission.invocation as Extract<CommandInvocation,{command:"task"}>;
    if(invocation.selection.kind==="pinned") { const claimed=await this.dependencies.store.compareAndSetCommandAttempt(current.updatedAt,superseded);if(claimed.kind!=="accepted")return;this.clearLive(current.attemptId,true);await this.dependencies.publishStatus(`watchdog:${current.attemptId}`,`— /task could not start for ${safeLabel(current.agentId)} —`);return; }
    const excluded=new Set(attempts.map((item)=>item.agentId));
    for(let conflicts=0;conflicts<MAX_COMMAND_ATTEMPTS;conflicts++){const roster=normalizeRoomAgentRoster(this.dependencies.roster());const candidates=await Promise.all(roster.entries.map(async(entry)=>({agentId:entry.agentId,eligible:entry.enabled&&!excluded.has(entry.agentId)&&await this.dependencies.canLaunch(entry.agentId)})));const pointer=await this.dependencies.store.getRoundRobinState(this.roomId);const resolution=resolveRoundRobin(candidates,pointer.lastAssignedAgentId);if(resolution.kind!=="selected"){const claimed=await this.dependencies.store.compareAndSetCommandAttempt(current.updatedAt,superseded);if(claimed.kind!=="accepted")return;this.clearLive(current.attemptId,true);await this.dependencies.publishStatus(`watchdog:${current.attemptId}`,"— /task stopped: no other eligible participant is available —");return;}const now=timestamp(this.clock);const next:CommandAttempt={attemptId:stableId(submission.submissionId,"attempt",String(current.attempt+1)),roomId:this.roomId,submissionId:submission.submissionId,attempt:current.attempt+1,agentId:resolution.agentId,generationId:null,status:"queued",reason:null,...this.captureEpoch(resolution.agentId),createdAt:now,updatedAt:now};const reassigned=await this.dependencies.store.reassignCommandAttempt({expectedUpdatedAt:current.updatedAt,current:superseded,next,roundRobin:{expectedRevision:pointer.revision,state:{roomId:this.roomId,lastAssignedAgentId:resolution.nextLastAssignedAgentId,revision:pointer.revision+1,updatedAt:timestamp(this.clock,pointer.updatedAt)}}});if(reassigned.kind==="conflict")continue;if(reassigned.kind!=="accepted")return;this.clearLive(current.attemptId,true);await this.dependencies.publishStatus(`watchdog:${current.attemptId}`,`— /task reassigned from ${safeLabel(current.agentId)} to ${safeLabel(next.agentId)} —`);await this.launch(submission,next.agentId,next.attempt,next);return;}
  }

  private agentCurrent(agentId:ActiveAgentId){const entry=roomAgentEntry(this.dependencies.roster(),agentId);return Boolean(entry?.enabled&&!entry.selectionConfirmationRequired);}
  private async startPov(execution:CommandPovExecution,submission:CommandSubmission){const current=await this.dependencies.store.getPovExecution(this.roomId,submission.submissionId);if(!current||!(current.status==="queued"||current.status==="active")||this.livePov.has(current.executionId))return;if(this.closing){if(current.currentTargetAgentId)return;const cancelled={...current,status:"cancelled" as const,reason:"server shutdown cancelled POV execution",updatedAt:timestamp(this.clock,current.updatedAt)};await this.dependencies.store.compareAndSetPovExecution(current.updatedAt,cancelled);return;}const active={...current,status:"active" as const,reason:null,updatedAt:timestamp(this.clock,current.updatedAt)};const claimed=await this.dependencies.store.compareAndSetPovExecution(current.updatedAt,active);if(claimed.kind!=="accepted")return;if(this.closing){if(active.currentTargetAgentId)return;const cancelled={...active,status:"cancelled" as const,reason:"server shutdown cancelled POV execution",updatedAt:timestamp(this.clock,active.updatedAt)};await this.dependencies.store.compareAndSetPovExecution(active.updatedAt,cancelled);return;}const controller=new AbortController();this.livePov.set(active.executionId,controller);void this.runPovTargets(active,submission,controller).then(()=>this.finishPov(active.executionId,"completed",null)).catch(async(error)=>{if(error instanceof PovDeliveryPendingError){this.livePov.delete(active.executionId);return;}if(controller.signal.aborted){const durable=await this.dependencies.store.getPovExecution(this.roomId,submission.submissionId);if(durable?.currentTargetAgentId){this.livePov.delete(active.executionId);return;}}return this.finishPov(active.executionId,controller.signal.aborted?"cancelled":"failed",error instanceof Error?error.message:String(error));});}
  private async runPovTargets(execution:CommandPovExecution,submission:CommandSubmission,controller:AbortController){for(;;){if(controller.signal.aborted)throw new Error("POV execution was cancelled.");const current=await this.dependencies.store.getPovExecution(this.roomId,submission.submissionId);if(!current||current.status!=="active")return;if(current.currentTargetAgentId){await this.resumePovDelivery(current,submission);continue;}const agentId=current.targetAgentIds.find((candidate)=>!current.processedTargetAgentIds.includes(candidate));if(!agentId)return;if(!await this.launchEligible(submission,agentId)){const skipped={...current,processedTargetAgentIds:[...current.processedTargetAgentIds,agentId],updatedAt:timestamp(this.clock,current.updatedAt)};const claimed=await this.dependencies.store.compareAndSetPovExecution(current.updatedAt,skipped);if(claimed.kind!=="accepted")throw new Error("POV target eligibility changed concurrently.");continue;}const authority=this.captureEpoch(agentId);const result=await this.dependencies.executePov(agentId,(submission.invocation as Extract<CommandInvocation,{command:"pov"}>).prompt,controller.signal);const messages=(result.visibleMessages||[]).filter(Boolean).slice(0,3).map((message)=>message.slice(0,MAX_COMMAND_DELIVERY_MESSAGE));const outbox={...current,currentTargetAgentId:agentId,generationId:result.generationId||null,deliveryMessages:messages,deliveryResult:durableDeliveryResult(result),...authority,updatedAt:timestamp(this.clock,current.updatedAt)};const claimed=await this.dependencies.store.compareAndSetPovExecution(current.updatedAt,outbox);if(claimed.kind!=="accepted")throw new Error("POV target ownership changed before durable result persistence.");await this.resumePovDelivery(outbox,submission,result);}}
  private async resumePovDelivery(execution:CommandPovExecution,submission:CommandSubmission,result?:CommandExecutionResult){const agentId=execution.currentTargetAgentId;if(!agentId)return;const messages=execution.deliveryMessages||[];if(!this.povAuthorityCurrent(execution)){await this.captureDiagnostic({agentId,attemptId:execution.executionId,generationId:execution.generationId||undefined,correlationId:`${execution.executionId}:${agentId}:authority-changed`,prompt:(submission.invocation as Extract<CommandInvocation,{command:"pov"}>).prompt,reason:"authority-changed-before-delivery",text:messages.join("\n"),metadata:{visibleMessages:messages.length}});}else try{await this.dependencies.deliverPov(stableId(execution.executionId,agentId),agentId,messages,result||{generationId:execution.generationId||undefined,visibleMessages:messages,...execution.deliveryResult});}catch(error){throw new PovDeliveryPendingError(error instanceof Error?error.message:String(error));}const completed={...execution,processedTargetAgentIds:[...execution.processedTargetAgentIds,agentId],currentTargetAgentId:null,generationId:null,deliveryMessages:undefined,deliveryResult:undefined,roomEpoch:undefined,rosterRevision:undefined,agentConfigurationRevision:undefined,updatedAt:timestamp(this.clock,execution.updatedAt)};const claimed=await this.dependencies.store.compareAndSetPovExecution(execution.updatedAt,completed);if(claimed.kind!=="accepted")throw new Error("POV delivery completion changed concurrently.");}
  private async finishPov(executionId:string,status:"completed"|"failed"|"cancelled",reason:string|null){const current=(await this.dependencies.store.listPendingPovExecutions(this.roomId)).find((item)=>item.executionId===executionId);if(!current)return;const terminal={...current,status,reason:reason?safeLabel(reason).slice(0,200):null,updatedAt:timestamp(this.clock,current.updatedAt)};await this.dependencies.store.compareAndSetPovExecution(current.updatedAt,terminal);this.livePov.delete(executionId);}
  private captureEpoch(agentId:ActiveAgentId){const roster=normalizeRoomAgentRoster(this.dependencies.roster());const entry=roomAgentEntry(roster,agentId);return{roomEpoch:this.dependencies.roomEpoch?.()||"0",rosterRevision:roster.revision,agentConfigurationRevision:entry?.configurationRevision||0};}
  private povAuthorityCurrent(execution:CommandPovExecution){if(!execution.currentTargetAgentId)return false;const roster=normalizeRoomAgentRoster(this.dependencies.roster());const entry=roomAgentEntry(roster,execution.currentTargetAgentId);return this.agentCurrent(execution.currentTargetAgentId)&&(!execution.roomEpoch||!this.dependencies.roomEpochCurrent||this.dependencies.roomEpochCurrent(execution.roomEpoch))&&(execution.rosterRevision===undefined||execution.rosterRevision===roster.revision)&&(execution.agentConfigurationRevision===undefined||execution.agentConfigurationRevision===(entry?.configurationRevision||0));}
  private attemptCurrent(attempt:CommandAttempt){const roster=normalizeRoomAgentRoster(this.dependencies.roster());const entry=roomAgentEntry(roster,attempt.agentId);return this.agentCurrent(attempt.agentId)&&(!attempt.roomEpoch||!this.dependencies.roomEpochCurrent||this.dependencies.roomEpochCurrent(attempt.roomEpoch))&&(attempt.rosterRevision===undefined||attempt.rosterRevision===roster.revision)&&(attempt.agentConfigurationRevision===undefined||attempt.agentConfigurationRevision===(entry?.configurationRevision||0));}
  private clearLive(attemptId:string,abort=false) { const live=this.live.get(attemptId); if(!live)return; if(live.timer)this.clock.clearTimeout(live.timer); if(abort)live.controller.abort(); live.reservation?.release(); this.live.delete(attemptId); }
  private armRecovered(attempt:CommandAttempt,submission:CommandSubmission) { const live:LiveAttempt={controller:new AbortController(),partial:""}; this.live.set(attempt.attemptId,live); const timeout=attempt.status==="queued"?this.stage1Ms:this.stage2Ms; const elapsed=Math.max(0,this.clock.now()-Date.parse(attempt.updatedAt)); live.timer=this.clock.setTimeout(()=>void (attempt.status==="queued"?this.stage1(attempt,submission,"server restarted before generation launch"):this.stage2(attempt,submission)),Math.max(0,timeout-elapsed)); }
}

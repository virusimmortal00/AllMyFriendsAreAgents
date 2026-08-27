import { createHash } from "node:crypto";
import { effectiveAllowedCommands, normalizeCommandPermissions, parseCommandInput, resolveRoundRobin, ROOM_COMMANDS, type CommandInput, type CommandInvocation, type RoomCommandName } from "../shared/command-domain.js";
import { isActiveAgentId, type ActiveAgentId } from "../shared/participants.js";
import { normalizeRoomAgentRoster, roomAgentEntry, type RoomAgentRoster } from "../shared/roster.js";
import { CANONICAL_ROOM_ID } from "./storage/room-repository.js";
import { MAX_DIAGNOSTIC_PROMPT_HEAD, MAX_DIAGNOSTIC_TEXT, publicPollProjection, type CommandAttempt, type CommandInvoker, type CommandRecordStore, type CommandSubmission, type DiagnosticRecord, type PublicPollProjection } from "./command-record.js";

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
  readonly executeTask: (agentId: ActiveAgentId, prompt: string, hooks: CommandLaunchHooks) => Promise<CommandExecutionResult>;
  readonly executePov: (agentIds: readonly ActiveAgentId[], prompt: string) => Promise<void>;
  readonly publishStatus: (text: string) => Promise<void>;
  readonly deliverTask: (agentId: ActiveAgentId, messages: readonly string[]) => Promise<void>;
  readonly ceiling?: readonly RoomCommandName[];
  readonly roomId?: string;
  readonly clock?: CommandClock;
  readonly stage1Ms?: number;
  readonly stage2Ms?: number;
}

export type CommandResponse =
  | { readonly kind: "private-error"; readonly message: string }
  | { readonly kind: "private-help"; readonly commands: readonly RoomCommandName[] }
  | { readonly kind: "accepted"; readonly submissionId: string; readonly duplicate: boolean; readonly poll?: PublicPollProjection };

interface LiveAttempt { readonly controller: AbortController; partial: string; timer?: unknown }

function boundedDelay(value: number | undefined, fallback: number, minimum: number, maximum: number) { return value === undefined ? fallback : Math.max(minimum, Math.min(maximum, Math.floor(value))); }
function stableId(...parts: string[]) { return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32); }
function timestamp(clock: CommandClock, after?: string) { const now = clock.now(); const previous = after ? Date.parse(after) : Number.NaN; return new Date(Number.isFinite(previous) ? Math.max(now, previous + 1) : now).toISOString(); }
function safeLabel(value: string) { return value.replace(/[\r\n\t]+/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "participant"; }
function promptFingerprint(prompt: string) { return `sha256:${createHash("sha256").update(prompt).digest("hex")}`; }
export function sanitizeDiagnosticText(input: string | undefined) {
  if (!input) return null;
  const secret = /(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|cookie|set-cookie)\s*[:=]\s*\S+/gi;
  const reasoning = /(?:chain of thought|internal reasoning|hidden reasoning)\s*[:=][^\n]*/gi;
  const sanitized = input.replace(secret, "$1[REDACTED]").replace(reasoning, "[REDACTED INTERNAL CONTENT]").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return sanitized ? sanitized.slice(0, MAX_DIAGNOSTIC_TEXT) : null;
}

export class CommandRuntime {
  private readonly roomId: string;
  private readonly clock: CommandClock;
  private readonly stage1Ms: number;
  private readonly stage2Ms: number;
  private readonly ceiling: readonly RoomCommandName[];
  private readonly live = new Map<string, LiveAttempt>();

  constructor(private readonly dependencies: CommandRuntimeDependencies) {
    this.roomId = dependencies.roomId || CANONICAL_ROOM_ID;
    this.clock = dependencies.clock || systemClock;
    this.stage1Ms = boundedDelay(dependencies.stage1Ms, DEFAULT_COMMAND_STAGE_1_MS, 1, 60_000);
    this.stage2Ms = boundedDelay(dependencies.stage2Ms, DEFAULT_COMMAND_STAGE_2_MS, 1, 300_000);
    this.ceiling = dependencies.ceiling || ROOM_COMMANDS;
  }

  async initialize() {
    for (const attempt of await this.dependencies.store.listPendingCommandAttempts(this.roomId)) {
      const submission = await this.dependencies.store.getCommandSubmission(this.roomId, attempt.submissionId);
      if (!submission || submission.invocation.command !== "task") continue;
      this.armRecovered(attempt, submission);
    }
  }

  close() {
    for (const [attemptId, live] of this.live) {
      if (live.timer) this.clock.clearTimeout(live.timer);
      live.controller.abort();
      this.live.delete(attemptId);
    }
  }

  async submit(input: CommandInput, invoker: CommandInvoker, clientSubmissionId: string): Promise<CommandResponse> {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(clientSubmissionId)) return { kind: "private-error", message: "A valid command request ID is required." };
    const parsed = parseCommandInput(input);
    if (parsed.kind !== "command") return parsed.kind === "private-error" ? parsed : { kind: "private-error", message: "No command was provided." };
    const allowed = this.allowed(invoker);
    if (!allowed.includes(parsed.invocation.command)) return { kind: "private-error", message: "That command is not available to this participant." };
    if (parsed.invocation.command === "help") return { kind: "private-help", commands: allowed };
    const createdAt = timestamp(this.clock);
    const submission: CommandSubmission = { submissionId: stableId(this.roomId, invoker.kind, invoker.id, clientSubmissionId), roomId: this.roomId, clientSubmissionId, command: parsed.invocation.command, invocation: parsed.invocation, invoker, createdAt };
    const persisted = await this.dependencies.store.createCommandSubmission(submission);
    if (persisted.kind === "duplicate") return this.replay(persisted.submission);
    return this.dispatch(submission);
  }

  async vote(pollId: string, voterId: string, optionIndex: number) {
    if (!voterId || !Number.isSafeInteger(optionIndex)) return { kind: "private-error" as const, message: "A valid poll choice is required." };
    const vote = await this.dependencies.store.createCommandVote({ roomId: this.roomId, pollId, voterId, optionIndex, createdAt: timestamp(this.clock) });
    if (vote.kind === "rejected") return { kind: "private-error" as const, message: vote.reason };
    const poll = await this.dependencies.store.getCommandPoll(this.roomId, pollId);
    if (!poll) return { kind: "private-error" as const, message: "Poll not found." };
    return { kind: "accepted" as const, duplicate: vote.kind === "duplicate", poll: publicPollProjection(poll, await this.dependencies.store.listCommandVotes(this.roomId, pollId)) };
  }

  async captureDiagnostic(input: { agentId: ActiveAgentId; attemptId: string; generationId?: string; correlationId: string; prompt: string; reason: string; text?: string; metadata?: DiagnosticRecord["metadata"] }) {
    const record: DiagnosticRecord = { recordId: stableId(this.roomId,input.correlationId), roomId: this.roomId, agentId: input.agentId, attemptId: input.attemptId, generationId: input.generationId || null, correlationId: input.correlationId.slice(0,500), promptHead: null, promptFingerprint: promptFingerprint(input.prompt), reason: safeLabel(input.reason), metadata: input.metadata || {}, diagnosticText: sanitizeDiagnosticText(input.text), createdAt: timestamp(this.clock) };
    return this.dependencies.store.appendDiagnostic(record);
  }

  private allowed(invoker: CommandInvoker) {
    if (invoker.kind === "human") return [...this.ceiling];
    if (!isActiveAgentId(invoker.id)) return [];
    const entry = roomAgentEntry(this.dependencies.roster(), invoker.id);
    return entry?.enabled ? effectiveAllowedCommands(normalizeCommandPermissions(entry.commandPermissions), this.ceiling) : [];
  }

  private async replay(submission: CommandSubmission): Promise<CommandResponse> {
    if (submission.command === "poll") {
      const poll = await this.dependencies.store.getCommandPoll(this.roomId, stableId(submission.submissionId,"poll"));
      if (poll) return { kind: "accepted", submissionId: submission.submissionId, duplicate: true, poll: publicPollProjection(poll, await this.dependencies.store.listCommandVotes(this.roomId,poll.pollId)) };
    }
    return { kind: "accepted", submissionId: submission.submissionId, duplicate: true };
  }

  private async dispatch(submission: CommandSubmission): Promise<CommandResponse> {
    const invocation = submission.invocation;
    if (invocation.command === "poll") {
      const created = await this.dependencies.store.createCommandPoll({ pollId: stableId(submission.submissionId,"poll"), roomId: this.roomId, submissionId: submission.submissionId, question: invocation.question, options: invocation.options, createdAt: submission.createdAt });
      await this.audit(submission, [], `— ${safeLabel(submission.invoker.displayName)} ran /poll — Options: ${invocation.options.map((option,index)=>`${index+1}. ${safeLabel(option)}`).join(" · ")}`);
      return { kind: "accepted", submissionId: submission.submissionId, duplicate: false, poll: publicPollProjection(created.poll,[]) };
    }
    if (invocation.command === "pov") {
      const targets = await this.eligibleAgents("pov");
      if (!targets.length) return { kind: "private-error", message: "No eligible participants are available." };
      await this.audit(submission, targets, this.auditText(submission, targets));
      void this.dependencies.executePov(targets, invocation.prompt);
      return { kind: "accepted", submissionId: submission.submissionId, duplicate: false };
    }
    if (invocation.command !== "task") return { kind: "private-error", message: "Unsupported command." };
    const selected = await this.selectTaskTarget(invocation);
    if (!selected) return { kind: "private-error", message: "No eligible participants are available." };
    await this.audit(submission, [selected], this.auditText(submission,[selected]));
    await this.launch(submission, selected, 1);
    return { kind: "accepted", submissionId: submission.submissionId, duplicate: false };
  }

  private async audit(submission: CommandSubmission, targets: readonly ActiveAgentId[], text: string) {
    const result = await this.dependencies.store.createCommandAuditIdentity({ auditId: stableId(submission.submissionId,"audit"), roomId: this.roomId, submissionId: submission.submissionId, command: submission.command, invokerKind: submission.invoker.kind, invokerId: submission.invoker.id, targetAgentIds: targets, createdAt: timestamp(this.clock) });
    if (result.kind === "created") await this.dependencies.publishStatus(text);
  }

  private auditText(submission: CommandSubmission, targets: readonly ActiveAgentId[]) {
    const roster = normalizeRoomAgentRoster(this.dependencies.roster());
    const names = targets.map((agent) => safeLabel(roster.entries.find((entry)=>entry.agentId===agent)?.conversationalName || agent));
    return `— ${safeLabel(submission.invoker.displayName)} ran /${submission.command} — Target${names.length===1?"":"s"}: ${names.join(", ")}`;
  }

  private async eligibleAgents(command: RoomCommandName, excluded = new Set<ActiveAgentId>()) {
    const roster = normalizeRoomAgentRoster(this.dependencies.roster());
    const result: ActiveAgentId[] = [];
    for (const entry of roster.entries) if (entry.enabled && !excluded.has(entry.agentId) && effectiveAllowedCommands(normalizeCommandPermissions(entry.commandPermissions),this.ceiling).includes(command) && await this.dependencies.canLaunch(entry.agentId)) result.push(entry.agentId);
    return result;
  }

  private async selectTaskTarget(invocation: Extract<CommandInvocation,{command:"task"}>, excluded = new Set<ActiveAgentId>()) {
    for (let conflicts=0; conflicts<MAX_COMMAND_ATTEMPTS; conflicts++) {
      const roster = normalizeRoomAgentRoster(this.dependencies.roster());
      const candidates = await Promise.all(roster.entries.map(async (entry)=>({ agentId: entry.agentId, eligible: entry.enabled && !excluded.has(entry.agentId) && effectiveAllowedCommands(normalizeCommandPermissions(entry.commandPermissions),this.ceiling).includes("task") && await this.dependencies.canLaunch(entry.agentId) })));
      const pointer = await this.dependencies.store.getRoundRobinState(this.roomId);
      const resolution = resolveRoundRobin(candidates,pointer.lastAssignedAgentId,invocation.selection.kind==="pinned"?invocation.selection.agentId:undefined);
      if (resolution.kind !== "selected") return undefined;
      if (!resolution.advancePointer) return resolution.agentId;
      const updatedAt = timestamp(this.clock,pointer.updatedAt);
      const advanced = await this.dependencies.store.compareAndSetRoundRobinState(pointer.revision,{ roomId:this.roomId,lastAssignedAgentId:resolution.nextLastAssignedAgentId,revision:pointer.revision+1,updatedAt });
      if (advanced.kind === "accepted") return resolution.agentId;
    }
    return undefined;
  }

  private async launch(submission: CommandSubmission, agentId: ActiveAgentId, attemptNumber: number) {
    if (attemptNumber > MAX_COMMAND_ATTEMPTS) return;
    const now = timestamp(this.clock);
    const created = await this.dependencies.store.createCommandAttempt({ attemptId: stableId(submission.submissionId,"attempt",String(attemptNumber)), roomId:this.roomId,submissionId:submission.submissionId,attempt:attemptNumber,agentId,generationId:null,status:"queued",reason:null,createdAt:now,updatedAt:now });
    if (created.kind === "duplicate" && created.attempt.status !== "queued") return;
    const attempt = created.attempt;
    if (!await this.launchEligible(submission,agentId)) return this.failAndReassign(attempt,submission,"eligibility changed before launch");
    const live: LiveAttempt = { controller:new AbortController(),partial:"" };
    this.live.set(attempt.attemptId,live);
    live.timer = this.clock.setTimeout(()=>void this.stage1(attempt,submission),this.stage1Ms);
    void this.dependencies.executeTask(agentId,(submission.invocation as Extract<CommandInvocation,{command:"task"}>).prompt,{ signal:live.controller.signal, partial:(text)=>{ live.partial=sanitizeDiagnosticText(text)||""; }, active:async (generationId)=>this.markActive(attempt,generationId,submission) }).then((result)=>this.complete(attempt,submission,result)).catch((error)=>this.fail(attempt,submission,error));
  }

  private async launchEligible(submission: CommandSubmission, agentId: ActiveAgentId) {
    const entry = roomAgentEntry(this.dependencies.roster(),agentId);
    return Boolean(entry?.enabled && effectiveAllowedCommands(normalizeCommandPermissions(entry.commandPermissions),this.ceiling).includes(submission.command) && await this.dependencies.canLaunch(agentId));
  }

  private async markActive(attempt: CommandAttempt,generationId:string,submission:CommandSubmission) {
    const live=this.live.get(attempt.attemptId); if (!live) return false;
    if (!await this.launchEligible(submission,attempt.agentId)) { await this.stage1(attempt,submission,"eligibility changed at generation start"); return false; }
    if (live.timer) this.clock.clearTimeout(live.timer);
    const active={...attempt,generationId,status:"active" as const,updatedAt:timestamp(this.clock,attempt.updatedAt)};
    const claimed=await this.dependencies.store.compareAndSetCommandAttempt(attempt.updatedAt,active);
    if(claimed.kind!=="accepted") return false;
    live.timer=this.clock.setTimeout(()=>void this.stage2(active,submission),this.stage2Ms);
    return true;
  }

  private async complete(attempt:CommandAttempt,submission:CommandSubmission,result:CommandExecutionResult) {
    const attempts=await this.dependencies.store.listCommandAttempts(this.roomId,submission.submissionId); const current=attempts.find((item)=>item.attemptId===attempt.attemptId); if(!current||!(current.status==="queued"||current.status==="active")) return;
    const completed={...current,generationId:result.generationId||current.generationId,status:"completed" as const,updatedAt:timestamp(this.clock,current.updatedAt)};
    const claimed=await this.dependencies.store.compareAndSetCommandAttempt(current.updatedAt,completed); if(claimed.kind!=="accepted") return;
    this.clearLive(attempt.attemptId);
    const visible=(result.visibleMessages||[]).filter(Boolean).slice(0,3);
    if(!visible.length) await this.captureDiagnostic({agentId:current.agentId,attemptId:current.attemptId,generationId:completed.generationId||undefined,correlationId:`${current.attemptId}:no-response`,prompt:(submission.invocation as Extract<CommandInvocation,{command:"task"}>).prompt,reason:"no-response-needed",text:result.diagnosticText||result.rawText,metadata:{visibleMessages:0}});
    else await this.dependencies.deliverTask(current.agentId,visible);
  }

  private async fail(attempt:CommandAttempt,submission:CommandSubmission,error:unknown) { const attempts=await this.dependencies.store.listCommandAttempts(this.roomId,submission.submissionId); const current=attempts.find((item)=>item.attemptId===attempt.attemptId); if(!current||!(current.status==="queued"||current.status==="active")) return; await this.failAndReassign(current,submission,error instanceof Error?error.message:String(error)); }
  private async stage1(attempt:CommandAttempt,submission:CommandSubmission,reason="generation did not start before the launch watchdog") { await this.failAndReassign(attempt,submission,reason); }
  private async stage2(attempt:CommandAttempt,submission:CommandSubmission) { const live=this.live.get(attempt.attemptId); if(live?.partial) await this.captureDiagnostic({agentId:attempt.agentId,attemptId:attempt.attemptId,generationId:attempt.generationId||undefined,correlationId:`${attempt.attemptId}:stage-2`,prompt:(submission.invocation as Extract<CommandInvocation,{command:"task"}>).prompt,reason:"generation-stalled",text:live.partial,metadata:{stage:2}}); await this.failAndReassign(attempt,submission,"generation stalled before a terminal outcome"); }

  private async failAndReassign(attempt:CommandAttempt,submission:CommandSubmission,reason:string) {
    const attempts=await this.dependencies.store.listCommandAttempts(this.roomId,submission.submissionId); const current=attempts.find((item)=>item.attemptId===attempt.attemptId); if(!current||!(current.status==="queued"||current.status==="active")) return;
    const superseded={...current,status:"superseded" as const,reason:safeLabel(reason).slice(0,200),updatedAt:timestamp(this.clock,current.updatedAt)};
    const claimed=await this.dependencies.store.compareAndSetCommandAttempt(current.updatedAt,superseded); if(claimed.kind!=="accepted") return;
    this.clearLive(current.attemptId,true);
    const invocation=submission.invocation as Extract<CommandInvocation,{command:"task"}>;
    if(invocation.selection.kind==="pinned") { await this.dependencies.publishStatus(`— /task could not start for ${safeLabel(current.agentId)} —`); return; }
    const excluded=new Set(attempts.map((item)=>item.agentId)); const next=await this.selectTaskTarget(invocation,excluded);
    if(!next) { await this.dependencies.publishStatus("— /task stopped: no other eligible participant is available —"); return; }
    await this.dependencies.publishStatus(`— /task reassigned from ${safeLabel(current.agentId)} to ${safeLabel(next)} —`);
    await this.launch(submission,next,Math.max(...attempts.map((item)=>item.attempt))+1);
  }

  private clearLive(attemptId:string,abort=false) { const live=this.live.get(attemptId); if(!live)return; if(live.timer)this.clock.clearTimeout(live.timer); if(abort)live.controller.abort(); this.live.delete(attemptId); }
  private armRecovered(attempt:CommandAttempt,submission:CommandSubmission) { const live:LiveAttempt={controller:new AbortController(),partial:""}; this.live.set(attempt.attemptId,live); const timeout=attempt.status==="queued"?this.stage1Ms:this.stage2Ms; const elapsed=Math.max(0,this.clock.now()-Date.parse(attempt.updatedAt)); live.timer=this.clock.setTimeout(()=>void (attempt.status==="queued"?this.stage1(attempt,submission,"server restarted before generation launch"):this.stage2(attempt,submission)),Math.max(0,timeout-elapsed)); }
}

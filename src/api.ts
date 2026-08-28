import type { AgentId, GovernedImprovementDetail, GovernedImprovementSummary, HeartbeatStatus, HumanPresence, RoomState, WorkshopResponse } from "./types";
import type { ChatStyle } from "../shared/chat-style";
import type { ConversationEnergy } from "../shared/conversation-energy";
import type { CommandMutationAcknowledgement, MessageMutationAcknowledgement, RoomContinuationWorkRequest, ServerIdentity } from "../shared/protocol";
import type { MessageMention } from "../shared/mentions";
import type { Task, TaskChange } from "../shared/task-domain";
import type { ContinuationDashboard, ContinuationInboxEntry, InvestigationDashboard, InvestigationInboxEntry } from "./types";
import type { RoomAgentRoster, RoomAgentRosterEntry } from "../shared/roster";
import type { ActiveAgentId, AgentProvider } from "../shared/participants";
import type { ModelDiscoveryResult, ModelAvailability, ModelOfferDetails, ModelReference } from "../shared/model-discovery";
import type { AgentCapabilityStatus } from "../shared/capabilities";

const REQUEST_TIMEOUT_MS = 8_000;
const READY_TIMEOUT_MS = 2_500;
let controlCsrfToken = "";
const pollVoteIds = new Map<string,string>();
const pollCloseIds = new Map<string,string>();

export function routedRoomId(location:Pick<Location,"pathname">=window.location){
  const match=/^\/rooms\/([a-zA-Z0-9-]{8,80})(?:\/|$)/.exec(location.pathname);
  return match ? match[1] : null;
}
function roomPath(endpoint:"state"|"messages"|"events"){
  const roomId=routedRoomId();
  return roomId?`/api/rooms/${encodeURIComponent(roomId)}/${endpoint}`:`/api/${endpoint}`;
}
export function roomEventsPath(){return roomPath("events");}

const GLOBAL_API_ROOTS=new Set(["ready","humans","style","avatar","control","provider-setup","model-discovery","model-details","rooms"]);
export function scopedRequestPath(path:string){
  const roomId=routedRoomId();
  if(!roomId||!path.startsWith("/api/")||path.startsWith("/api/rooms/"))return path;
  const root=path.slice(5).split(/[/?]/,1)[0];
  return GLOBAL_API_ROOTS.has(root)?path:`/api/rooms/${encodeURIComponent(roomId)}/${path.slice(5)}`;
}

export class ApiRequestError extends Error {
  constructor(message: string, readonly outcomeUnknown = false, readonly status?: number, readonly body?: unknown) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function request(path: string, options: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS, acceptedErrorStatuses: readonly number[] = []) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (externalSignal?.aborted) abortFromCaller();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(options.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(scopedRequestPath(path), {
      ...options,
      headers,
      signal: controller.signal,
    });
    if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiRequestError(body.error || `Request failed with status ${response.status}`, false, response.status, body);
    }
    return response;
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    const mutating = options.method && options.method !== "GET" && options.method !== "HEAD";
    throw new ApiRequestError(
      controller.signal.aborted ? "The room server did not respond in time." : "The room connection was interrupted.",
      Boolean(mutating),
    );
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export interface TaskDetailResponse {
  task: Task;
  history: readonly { revision: number; actorId: string; at: string; change: unknown }[];
  relationships: { dependencies: readonly { roomId: string; taskId: string }[]; blockers: readonly { roomId: string; taskId: string }[]; dependents: readonly { roomId: string; taskId: string }[] };
}

export async function loadTasks() {
  return request("/api/tasks", { method: "GET", cache: "no-store" }).then((response) => response.json() as Promise<{ items: Task[]; nextCursor: string | null }>);
}

export async function loadTask(taskId: string) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "GET", cache: "no-store" }).then((response) => response.json() as Promise<TaskDetailResponse>);
}

export async function createRoomTask(title: string, description: string) {
  return request("/api/tasks", { method: "POST", body: JSON.stringify({ title, description }) }).then((response) => response.json() as Promise<Task>);
}

export async function taskAction(taskId: string, action: string, body: Record<string, unknown>) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST", body: JSON.stringify(body) }).then((response) => response.json() as Promise<Task>);
}

export async function updateRoomTask(taskId: string, expectedRevision: number, field: "title" | "description", value: string) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", body: JSON.stringify({ expectedRevision, [field]: value }) }).then((response) => response.json() as Promise<Task>);
}

export async function loadContributions() {
  return request("/api/contributions", { method: "GET", cache: "no-store" }).then((response) => response.json());
}

export async function loadContribution(id: string) {
  return request(`/api/contributions/${encodeURIComponent(id)}`, { method: "GET", cache: "no-store" }).then((response) => response.json());
}

export async function contributionGate(id: string, action: "approve" | "execute", kind: "publication" | "merge" | "deployment", body: Record<string, unknown>) {
  return request(`/api/contributions/${encodeURIComponent(id)}/${action}/${kind}`, { method: "POST", body: JSON.stringify(body) }).then((response) => response.json());
}

export async function checkReady(): Promise<ServerIdentity> {
  return request("/api/ready", { method: "GET", cache: "no-store" }, READY_TIMEOUT_MS).then((response) => response.json());
}

export async function loadRoom(): Promise<RoomState> {
  return request(roomPath("state")).then((response) => response.json());
}

export async function requestProviderRecovery(providerId: string) {
  return request(`/api/provider-health/${encodeURIComponent(providerId)}/recover`, { method: "POST", body: "{}" }).then((response) => response.json());
}

export interface RosterCatalogEntry {
  readonly agentId: ActiveAgentId;
  readonly provider: AgentProvider;
  readonly displayName: string;
  readonly modelId: string;
  readonly modelLabel: string;
  readonly conversationalName: string;
  readonly supportsProjectWrites: boolean;
}

export interface RosterResponse {
  readonly roster: RoomAgentRoster;
  readonly catalog: readonly RosterCatalogEntry[];
  readonly modelDiscovery?: ModelDiscoveryResult;
  readonly participantAvailability?: Partial<Record<ActiveAgentId, ModelAvailability>>;
  readonly capabilityStatuses?: Readonly<Record<string, AgentCapabilityStatus>>;
}

export async function refreshModelDiscovery(): Promise<ModelDiscoveryResult> {
  return request("/api/model-discovery/refresh", { method: "POST", headers: { "X-AMFAA-CSRF": controlCsrfToken }, body: "{}" }).then((response) => response.json());
}

export async function loadModelOfferDetails(providerId: string, modelId: string, signal?: AbortSignal): Promise<ModelOfferDetails> {
  const query = new URLSearchParams({ providerId, modelId });
  return request(`/api/model-details?${query}`, { method: "GET", cache: "no-store", signal })
    .then((response) => response.json());
}

export async function loadRoster(): Promise<RosterResponse> {
  return request("/api/roster", { method: "GET", cache: "no-store" }).then((response) => response.json());
}

export async function updateRoster(expectedRevision: number, entries: readonly RoomAgentRosterEntry[]): Promise<RosterResponse> {
  return request("/api/roster", { method: "PUT", headers: { "X-AMFAA-CSRF": controlCsrfToken }, body: JSON.stringify({ expectedRevision, entries }) }).then((response) => response.json());
}

export interface RoomConfiguration {
  configurationRevision: number;
  basePromptRevision: number;
  basePromptText: string | null;
  summarizerModel: ModelReference | null;
  summarizerPromptText: string;
  summarizerPromptRevision: number;
  featureFlags: Record<string, boolean>;
  preflightMode: import("../shared/preflight").PreflightMode;
  updatedAt: string | null;
}

export interface RoomConfigurationResponse {
  settings: RoomConfiguration;
  defaults?: { basePromptText: string };
  modelDiscovery?: ModelDiscoveryResult;
  routingEvidence?: import("../shared/preflight").PreflightEvidence;
}

export async function loadRoomConfiguration(): Promise<RoomConfigurationResponse> {
  return request("/api/room/settings", { method: "GET", cache: "no-store" }).then((response) => response.json());
}

export async function updateRoomConfiguration(update: Partial<{ basePromptText: string | null; summarizerModel: ModelReference | null; summarizerPromptText: string; featureFlags: Record<string, boolean>; preflightMode: import("../shared/preflight").PreflightMode }>): Promise<{ settings: RoomConfiguration }> {
  return request("/api/room/settings", { method: "PUT", headers: { "X-AMFAA-CSRF": controlCsrfToken }, body: JSON.stringify(update) }).then((response) => response.json());
}

export interface ControlPrincipal { id: string; username: string; role: "OWNER" | "ADMIN" | "MEMBER"; capabilities: string[]; revision: number; }
export async function loadControlStatus() { return request("/api/control/status", { method: "GET", cache: "no-store" }).then((response) => response.json() as Promise<{ claimed: boolean; bootstrapConfigured: boolean }>); }
export async function loadControlMe() { const result = await request("/api/control/me", { method: "GET", cache: "no-store" }).then((response) => response.json() as Promise<{ principal: ControlPrincipal; csrfToken: string }>); controlCsrfToken = result.csrfToken; return result; }
export async function controlLogin(username: string, password: string) { const result = await request("/api/control/login", { method: "POST", body: JSON.stringify({ username, password }) }).then((response) => response.json() as Promise<{ principal: ControlPrincipal; csrfToken: string }>); controlCsrfToken = result.csrfToken; return result; }
export async function bootstrapControlPlane(bootstrapSecret: string, username: string, password: string) { const result = await request("/api/control/bootstrap", { method: "POST", body: JSON.stringify({ bootstrapSecret, username, password }) }).then((response) => response.json() as Promise<{ principal: ControlPrincipal; csrfToken: string }>); controlCsrfToken = result.csrfToken; return result; }
export async function loadProviderSetup() { return request("/api/provider-setup", { method: "GET", cache: "no-store" }).then((response) => response.json()); }
export async function initiateProviderSetup() { return request("/api/provider-setup/initiate", { method: "POST", headers: { "X-AMFAA-CSRF": controlCsrfToken }, body: "{}" }).then((response) => response.json()); }
export async function refreshProviderSetup() { return request("/api/provider-setup/refresh", { method: "POST", headers: { "X-AMFAA-CSRF": controlCsrfToken }, body: "{}" }).then((response) => response.json() as Promise<ModelDiscoveryResult>); }
export async function loadControlPrincipals() { return request("/api/control/principals", { method: "GET", cache: "no-store" }).then((response) => response.json() as Promise<{ principals: ControlPrincipal[] }>); }
export async function createControlPrincipal(username: string, password: string, role: "ADMIN" | "MEMBER", capabilities: string[]) { return request("/api/control/principals", { method: "POST", headers: { "X-AMFAA-CSRF": controlCsrfToken }, body: JSON.stringify({ username, password, role, capabilities }) }).then((response) => response.json() as Promise<ControlPrincipal>); }
export async function updateControlGrants(principal: ControlPrincipal, role: "ADMIN" | "MEMBER", capabilities: string[]) { return request(`/api/control/principals/${principal.id}/grants`, { method: "PUT", headers: { "X-AMFAA-CSRF": controlCsrfToken }, body: JSON.stringify({ expectedRevision: principal.revision, role, capabilities }) }).then((response) => response.json() as Promise<ControlPrincipal>); }

export async function updateSettings(settings: { roomName?: string; topic?: string; conversationEnergy?: ConversationEnergy }) {
  return request("/api/settings", {
    method: "PATCH",
    headers: { "X-AMFAA-CSRF": controlCsrfToken },
    body: JSON.stringify(settings),
  });
}

export async function joinRoom(profile: { id?: string; name: string; style?: ChatStyle; avatarUrl?: string }): Promise<HumanPresence> {
  return request("/api/humans", {
    method: "POST",
    body: JSON.stringify({ name: profile.name, style: profile.style, avatarUrl: profile.avatarUrl }),
  }).then((response) => response.json());
}

export async function updateMyStyle(style: ChatStyle) {
  return request("/api/style", {
    method: "PATCH",
    body: JSON.stringify({ style }),
  });
}

export async function updateMyAvatar(avatarUrl?: string): Promise<HumanPresence> {
  return request("/api/avatar", {
    method: "PATCH",
    body: JSON.stringify({ avatarUrl: avatarUrl || null }),
  }).then((response) => response.json());
}

export async function updateMyProfile(profile: { name: string; avatarUrl?: string }): Promise<HumanPresence> {
  return request("/api/humans", {
    method: "POST",
    body: JSON.stringify({ name: profile.name, avatarUrl: profile.avatarUrl || null }),
  }).then((response) => response.json());
}

export async function sendMessage(text: string, clientMessageId: string, mentions: MessageMention[] = [], continuation?: RoomContinuationWorkRequest): Promise<MessageMutationAcknowledgement | CommandMutationAcknowledgement> {
  return request(roomPath("messages"), {
    method: "POST",
    body: JSON.stringify({ text, clientMessageId, mentions, ...(continuation ? { continuation } : {}) }),
  }, REQUEST_TIMEOUT_MS, [400]).then(async (response) => {
    const acknowledgement: unknown = await response.json().catch(() => ({}));
    if (!response.ok && !(response.status === 400 && isCommandAcknowledgement(acknowledgement))) {
      const body = acknowledgement as { error?: string };
      throw new ApiRequestError(body.error || `Request failed with status ${response.status}`, false, response.status, acknowledgement);
    }
    return acknowledgement;
  }).then((acknowledgement: unknown) => {
    if (isCommandAcknowledgement(acknowledgement) && acknowledgement.clientSubmissionId === clientMessageId) return acknowledgement;
    if (!isMessageAcknowledgement(acknowledgement) || acknowledgement.clientMessageId !== clientMessageId) {
      throw new ApiRequestError("The room returned an incompatible message acknowledgement.", true);
    }
    return acknowledgement;
  });
}

function isCommandAcknowledgement(value: unknown): value is CommandMutationAcknowledgement { const acknowledgement=value as Partial<CommandMutationAcknowledgement>|null; return Boolean(acknowledgement&&acknowledgement.command===true&&typeof acknowledgement.clientSubmissionId==="string"&&acknowledgement.result&&(acknowledgement.result.kind==="accepted"||acknowledgement.result.kind==="private-help"||acknowledgement.result.kind==="private-error")); }

export async function loadPolls() {
  return request("/api/polls", { method: "GET", cache: "no-store" }).then((response) => response.json() as Promise<{ items: import("./types").PublicPollProjection[] }>);
}

/** Owner diagnostics are intentionally never fetched as part of room state or SSE. */
export interface OwnerDiagnosticRecord { recordId: string; stream: string; timestamp: string; severity: string; event: string; correlationId?: string; requestId?: string; traceId?: string; content: Record<string, unknown>; }
export interface OwnerDiagnosticChunk { kind: "record-chunk"; recordId: string; stream: string; offset: number; totalBytes: number; encoding: "base64-json-utf8"; data: string; final: boolean; }
export interface OwnerDiagnosticsResult { records: OwnerDiagnosticRecord[]; chunks: OwnerDiagnosticChunk[]; nextCursor: string | null; scannedBytes: number; serializedBytes: number; malformedRecords: number; scanLimitReached: boolean; }
export async function queryOwnerDiagnostics(query: Record<string, unknown>): Promise<OwnerDiagnosticsResult> {
  const send = () => request("/api/control/diagnostics/query", { method: "POST", cache: "no-store", headers: controlCsrfToken ? { "X-AMFAA-CSRF": controlCsrfToken } : {}, body: JSON.stringify(query) }).then((response) => response.json() as Promise<OwnerDiagnosticsResult>);
  try { return await send(); }
  catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 403) throw error;
    await loadControlMe();
    return send();
  }
}

export interface CapabilityDiagnosticsResponse {
  readonly policyRevision: 1;
  readonly agents: Readonly<Record<string, AgentCapabilityStatus>>;
  readonly audit: readonly { id: string; timestamp: string; agentId: string; capability: string; outcome: string; correlationId?: string; reason?: string }[];
}

export async function loadOwnerCapabilityDiagnostics(): Promise<CapabilityDiagnosticsResponse> {
  return request("/api/control/capabilities?limit=100", { method: "GET", cache: "no-store" }).then((response) => response.json());
}

export async function voteOnPoll(pollId: string, optionIndex: number) {
  const storageKey = "amfaa.command.poll-votes.v1";
  let stored: Record<string,string> = {};
  try { stored = JSON.parse(window.localStorage.getItem(storageKey) || "{}"); } catch { stored = {}; }
  const candidate = pollVoteIds.get(pollId) || stored[pollId] || "";
  const clientVoteId = /^[a-zA-Z0-9_-]{8,100}$/.test(candidate) ? candidate : `pollvote_${crypto.randomUUID()}`;
  pollVoteIds.set(pollId,clientVoteId);
  if (!stored[pollId]) {
    const entries = [...Object.entries(stored), [pollId, clientVoteId] as const].slice(-100);
    try { window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries))); } catch { /* server voter identity still deduplicates same-session retries */ }
  }
  return request(`/api/polls/${encodeURIComponent(pollId)}/votes`, { method: "POST", body: JSON.stringify({ optionIndex, clientVoteId }) }).then((response) => response.json());
}

export async function closePoll(pollId:string,expectedRevision:number){
  const storageKey="amfaa.command.poll-closes.v1";
  let stored:Record<string,string>={};
  try{stored=JSON.parse(window.localStorage.getItem(storageKey)||"{}");}catch{stored={};}
  const candidate=pollCloseIds.get(pollId)||stored[pollId]||"";
  const clientCloseId=/^[a-zA-Z0-9_-]{8,100}$/.test(candidate)?candidate:`pollclose_${crypto.randomUUID()}`;
  pollCloseIds.set(pollId,clientCloseId);
  if(!stored[pollId]){const entries=[...Object.entries(stored),[pollId,clientCloseId] as const].slice(-100);try{window.localStorage.setItem(storageKey,JSON.stringify(Object.fromEntries(entries)));}catch{/* The durable server mutation still protects in-process retries. */}}
  const send=()=>request(`/api/polls/${encodeURIComponent(pollId)}/close`,{method:"POST",headers:controlCsrfToken?{"X-AMFAA-CSRF":controlCsrfToken}:{},body:JSON.stringify({clientCloseId,expectedRevision})}).then((response)=>response.json() as Promise<{kind:"accepted";poll:import("./types").PublicPollProjection}>);
  try{return await send();}catch(error){
    if(controlCsrfToken||!(error instanceof ApiRequestError)||error.status!==403)throw error;
    try{await loadControlMe();}catch{throw error;}
    return send();
  }
}

export async function sendContinuationWorkRequest(task: Pick<Task, "taskId" | "revision" | "title">, assignmentReferenceId: string, objective: string) {
  const continuation = { taskId: task.taskId, taskRevision: task.revision, assignmentReferenceId, objective };
  const key = JSON.stringify(continuation);
  const clientMessageId = pendingContinuationMessageIds.get(key) || `message_${crypto.randomUUID()}`;
  pendingContinuationMessageIds.set(key, clientMessageId);
  try {
    const acknowledgement = await sendMessage(`Start governed continuation for “${task.title}”: ${objective}`, clientMessageId, [], continuation);
    if ("command" in acknowledgement) throw new ApiRequestError("The room returned a command response for a continuation request.", true);
    if (pendingContinuationMessageIds.get(key) === clientMessageId) pendingContinuationMessageIds.delete(key);
    return acknowledgement;
  } catch (error) {
    if (!(error instanceof ApiRequestError && error.outcomeUnknown) && pendingContinuationMessageIds.get(key) === clientMessageId) pendingContinuationMessageIds.delete(key);
    throw error;
  }
}

const pendingContinuationMessageIds = new Map<string, string>();

function isMessageAcknowledgement(value: unknown): value is MessageMutationAcknowledgement {
  if (!value || typeof value !== "object") return false;
  const acknowledgement = value as Partial<MessageMutationAcknowledgement>;
  return acknowledgement.accepted === true
    && typeof acknowledgement.duplicate === "boolean"
    && typeof acknowledgement.clientMessageId === "string"
    && typeof acknowledgement.messageId === "string";
}

export async function runAction(action: "ask" | "review" | "roundtable" | "continue", target: AgentId | "all") {
  return request("/api/actions", {
    method: "POST",
    body: JSON.stringify({ action, target }),
  });
}

export async function loadWorkshop(id: string): Promise<WorkshopResponse> {
  return request(`/api/improvements/${encodeURIComponent(id)}`, { method: "GET", cache: "no-store" }).then((response) => response.json());
}

export async function loadImprovements(scope: "active" | "all"): Promise<{ scope: string; items: GovernedImprovementSummary[] }> {
  return request(`/api/improvements?scope=${scope}&limit=50`, { method: "GET", cache: "no-store" }).then((response) => response.json());
}

export async function loadImprovement(id: string): Promise<GovernedImprovementDetail> {
  return request(`/api/improvements/${encodeURIComponent(id)}`, { method: "GET", cache: "no-store" }).then((response) => response.json());
}

export async function loadHeartbeat(): Promise<HeartbeatStatus> {
  return request("/api/heartbeat", { method: "GET", cache: "no-store" }).then((response) => response.json());
}

export async function authorizeHeartbeat(expectedRevision: number) {
  return request("/api/heartbeat/authorize", { method: "POST", body: JSON.stringify({ expectedRevision, reason: "Explicitly authorized from the visible heartbeat control" }) }).then((response) => response.json() as Promise<HeartbeatStatus>);
}

export async function emergencyStopHeartbeat(expectedRevision: number) {
  return request("/api/heartbeat/emergency-stop", { method: "POST", body: JSON.stringify({ expectedRevision, reason: "Emergency stop requested from the visible control" }) }).then((response) => response.json() as Promise<HeartbeatStatus>);
}

export async function loadContinuations(signal?: AbortSignal): Promise<ContinuationDashboard> { return request("/api/continuations", { method: "GET", cache: "no-store", signal }).then((response) => response.json()); }
export async function setContinuationPolicy(expectedRevision: number, enabled: boolean) { return request("/api/continuations/policy", { method: "PATCH", body: JSON.stringify({ expectedRevision, enabled }) }).then((response) => response.json()); }
export async function continuationAction(jobId: string, action: "cancel" | "resume") { return request(`/api/continuations/${encodeURIComponent(jobId)}/${action}`, { method: "POST", body: "{}" }).then((response) => response.json()); }
export async function loadContinuationInbox(owner: AgentId, signal?: AbortSignal): Promise<ContinuationInboxEntry[]> { return request(`/api/continuations/inbox/${encodeURIComponent(owner)}`, { method: "GET", cache: "no-store", signal }).then((response) => response.json()); }
export async function acknowledgeContinuationInbox(inboxEntryId: string, close: boolean) { return request(`/api/continuations/inbox/${encodeURIComponent(inboxEntryId)}/acknowledge`, { method: "POST", body: JSON.stringify({ close }) }).then((response) => response.json()); }
export async function loadInvestigations(signal?: AbortSignal): Promise<InvestigationDashboard> { return request("/api/investigations", { method: "GET", cache: "no-store", signal }).then((response) => response.json()); }
export async function setInvestigationPolicy(expectedRevision: number, enabled: boolean) { return request("/api/investigations/policy", { method: "PATCH", body: JSON.stringify({ expectedRevision, enabled }) }).then((response) => response.json()); }
export async function investigationAction(investigationId: string, action: "cancel" | "resume") { return request(`/api/investigations/${encodeURIComponent(investigationId)}/${action}`, { method: "POST", body: "{}" }).then((response) => response.json()); }
export async function loadInvestigationInbox(owner: AgentId, signal?: AbortSignal): Promise<InvestigationInboxEntry[]> { return request(`/api/investigations/inbox/${encodeURIComponent(owner)}`, { method: "GET", cache: "no-store", signal }).then((response) => response.json()); }
export async function acknowledgeInvestigationInbox(inboxEntryId: string, close: boolean) { return request(`/api/investigations/inbox/${encodeURIComponent(inboxEntryId)}/acknowledge`, { method: "POST", body: JSON.stringify({ close }) }).then((response) => response.json()); }

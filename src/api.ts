import type { AgentId, GovernedImprovementDetail, GovernedImprovementSummary, HeartbeatStatus, HumanPresence, RoomState, WorkshopResponse } from "./types";
import type { ChatStyle } from "../shared/chat-style";
import type { ConversationEnergy } from "../shared/conversation-energy";
import type { MessageMutationAcknowledgement, RoomContinuationWorkRequest, ServerIdentity } from "../shared/protocol";
import type { MessageMention } from "../shared/mentions";
import type { Task, TaskChange } from "../shared/task-domain";
import type { ContinuationDashboard, ContinuationInboxEntry, InvestigationDashboard, InvestigationInboxEntry } from "./types";
import type { RoomAgentRoster, RoomAgentRosterEntry } from "../shared/roster";
import type { ActiveAgentId, AgentProvider } from "../shared/participants";
import type { ModelDiscoveryResult, ModelAvailability, ModelOfferDetails, ModelReference } from "../shared/model-discovery";

const REQUEST_TIMEOUT_MS = 8_000;
const READY_TIMEOUT_MS = 2_500;
let controlCsrfToken = "";

export class ApiRequestError extends Error {
  constructor(message: string, readonly outcomeUnknown = false, readonly status?: number, readonly body?: unknown) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function request(path: string, options: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (externalSignal?.aborted) abortFromCaller();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(options.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(path, {
      ...options,
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
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
  return request("/api/state").then((response) => response.json());
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
  basePromptRevision: number;
  basePromptText: string | null;
  summarizerModel: ModelReference | null;
  summarizerPromptText: string;
  summarizerPromptRevision: number;
  featureFlags: Record<string, boolean>;
  updatedAt: string | null;
}

export interface RoomConfigurationResponse {
  settings: RoomConfiguration;
  defaults?: { basePromptText: string };
  modelDiscovery?: ModelDiscoveryResult;
}

export async function loadRoomConfiguration(): Promise<RoomConfigurationResponse> {
  return request("/api/room/settings", { method: "GET", cache: "no-store" }).then((response) => response.json());
}

export async function updateRoomConfiguration(update: Partial<{ basePromptText: string | null; summarizerModel: ModelReference | null; summarizerPromptText: string; featureFlags: Record<string, boolean> }>): Promise<{ settings: RoomConfiguration }> {
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

export async function sendMessage(text: string, clientMessageId: string, mentions: MessageMention[] = [], continuation?: RoomContinuationWorkRequest): Promise<MessageMutationAcknowledgement> {
  return request("/api/messages", {
    method: "POST",
    body: JSON.stringify({ text, clientMessageId, mentions, ...(continuation ? { continuation } : {}) }),
  }).then((response) => response.json()).then((acknowledgement: unknown) => {
    if (!isMessageAcknowledgement(acknowledgement) || acknowledgement.clientMessageId !== clientMessageId) {
      throw new ApiRequestError("The room returned an incompatible message acknowledgement.", true);
    }
    return acknowledgement;
  });
}

export async function sendContinuationWorkRequest(task: Pick<Task, "taskId" | "revision" | "title">, assignmentReferenceId: string, objective: string) {
  const continuation = { taskId: task.taskId, taskRevision: task.revision, assignmentReferenceId, objective };
  const key = JSON.stringify(continuation);
  const clientMessageId = pendingContinuationMessageIds.get(key) || `message_${crypto.randomUUID()}`;
  pendingContinuationMessageIds.set(key, clientMessageId);
  try {
    const acknowledgement = await sendMessage(`Start governed continuation for “${task.title}”: ${objective}`, clientMessageId, [], continuation);
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

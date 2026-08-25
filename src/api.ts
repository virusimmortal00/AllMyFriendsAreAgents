import type { AgentId, GovernedImprovementDetail, GovernedImprovementSummary, HeartbeatStatus, HumanPresence, RoomState, WorkshopResponse, WritableAgent } from "./types";
import type { ChatStyle } from "../shared/chat-style";
import type { ConversationEnergy } from "../shared/conversation-energy";
import type { MessageMutationAcknowledgement, ServerIdentity } from "../shared/protocol";
import type { MessageMention } from "../shared/mentions";
import type { Task, TaskChange } from "../shared/task-domain";
import type { ContinuationDashboard, ContinuationInboxEntry, InvestigationDashboard, InvestigationInboxEntry } from "./types";

const REQUEST_TIMEOUT_MS = 8_000;
const READY_TIMEOUT_MS = 2_500;

export class ApiRequestError extends Error {
  constructor(message: string, readonly outcomeUnknown = false, readonly status?: number) {
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
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiRequestError(body.error || `Request failed with status ${response.status}`, false, response.status);
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

export async function checkReady(): Promise<ServerIdentity> {
  return request("/api/ready", { method: "GET", cache: "no-store" }, READY_TIMEOUT_MS).then((response) => response.json());
}

export async function loadRoom(): Promise<RoomState> {
  return request("/api/state").then((response) => response.json());
}

export async function updateSettings(settings: { roomName?: string; topic?: string; writableAgent?: WritableAgent; conversationEnergy?: ConversationEnergy; actorId?: string }) {
  return request("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(settings),
  });
}

export async function joinRoom(profile: { id?: string; name: string; style?: ChatStyle }): Promise<HumanPresence> {
  return request("/api/humans", {
    method: "POST",
    body: JSON.stringify(profile),
  }).then((response) => response.json());
}

export async function updateMyStyle(humanId: string, style: ChatStyle) {
  return request("/api/style", {
    method: "PATCH",
    body: JSON.stringify({ humanId, style }),
  });
}

export async function sendMessage(humanId: string, text: string, clientMessageId: string, mentions: MessageMention[] = []): Promise<MessageMutationAcknowledgement> {
  return request("/api/messages", {
    method: "POST",
    body: JSON.stringify({ humanId, text, clientMessageId, mentions }),
  }).then((response) => response.json()).then((acknowledgement: unknown) => {
    if (!isMessageAcknowledgement(acknowledgement) || acknowledgement.clientMessageId !== clientMessageId) {
      throw new ApiRequestError("The room returned an incompatible message acknowledgement.", true);
    }
    return acknowledgement;
  });
}

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
  return request("/api/heartbeat/authorize", { method: "POST", body: JSON.stringify({ expectedRevision, actorId: "local-human-operator", reason: "Explicitly authorized from the visible heartbeat control" }) }).then((response) => response.json() as Promise<HeartbeatStatus>);
}

export async function emergencyStopHeartbeat(expectedRevision: number) {
  return request("/api/heartbeat/emergency-stop", { method: "POST", body: JSON.stringify({ expectedRevision, actorId: "local-human-operator", reason: "Emergency stop requested from the visible control" }) }).then((response) => response.json() as Promise<HeartbeatStatus>);
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

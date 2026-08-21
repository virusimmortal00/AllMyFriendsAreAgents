import type { AgentId, GovernedImprovementDetail, GovernedImprovementSummary, HeartbeatStatus, HumanPresence, RoomState, WorkshopResponse, WritableAgent } from "./types";
import type { ChatStyle } from "../shared/chat-style";
import type { ConversationEnergy } from "../shared/conversation-energy";
import type { ServerIdentity } from "../shared/protocol";

const REQUEST_TIMEOUT_MS = 8_000;
const READY_TIMEOUT_MS = 2_500;

export class ApiRequestError extends Error {
  constructor(message: string, readonly outcomeUnknown = false) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function request(path: string, options: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiRequestError(body.error || `Request failed with status ${response.status}`);
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
  }
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

export async function sendMessage(humanId: string, text: string, clientMessageId: string): Promise<RoomState> {
  return request("/api/messages", {
    method: "POST",
    body: JSON.stringify({ humanId, text, clientMessageId }),
  }).then((response) => response.json());
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

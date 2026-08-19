import type { AgentId, RoomState, WritableAgent } from "./types";
import type { ChatStyle } from "../shared/chat-style";

async function request(path: string, options?: RequestInit) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Request failed with status ${response.status}`);
  }
  return response;
}

export async function loadRoom(): Promise<RoomState> {
  return request("/api/state").then((response) => response.json());
}

export async function updateSettings(settings: { topic?: string; writableAgent?: WritableAgent; maxRounds?: number }) {
  return request("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(settings),
  });
}

export async function updateMyStyle(style: ChatStyle) {
  return request("/api/style", {
    method: "PATCH",
    body: JSON.stringify(style),
  });
}

export async function sendMessage(text: string): Promise<RoomState> {
  return request("/api/messages", {
    method: "POST",
    body: JSON.stringify({ text }),
  }).then((response) => response.json());
}

export async function runAction(action: "ask" | "review" | "roundtable", target: AgentId | "both") {
  return request("/api/actions", {
    method: "POST",
    body: JSON.stringify({ action, target }),
  });
}

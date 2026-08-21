import type { AgentId, HumanPresence, RoomState, WritableAgent } from "./types";
import type { ChatStyle } from "../shared/chat-style";
import type { ConversationEnergy } from "../shared/conversation-energy";

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

export async function updateSettings(settings: { roomName?: string; topic?: string; writableAgent?: WritableAgent; conversationEnergy?: ConversationEnergy }) {
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

export async function sendMessage(humanId: string, text: string): Promise<RoomState> {
  return request("/api/messages", {
    method: "POST",
    body: JSON.stringify({ humanId, text }),
  }).then((response) => response.json());
}

export async function runAction(action: "ask" | "review" | "roundtable" | "continue", target: AgentId | "all") {
  return request("/api/actions", {
    method: "POST",
    body: JSON.stringify({ action, target }),
  });
}

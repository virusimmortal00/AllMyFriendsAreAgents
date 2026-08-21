import type { ChatStyle, StyledParticipant } from "../../shared/chat-style.js";
import type { AgentId, RoomMessage, RoomSettings, RoomState } from "../types.js";

export interface RoomRepository {
  snapshot(): RoomState;
  addMessage(
    speaker: RoomMessage["speaker"],
    text: string,
    kind?: RoomMessage["kind"],
    style?: ChatStyle,
    burst?: { burstId: string; sequence: number },
    human?: { id: string; name: string },
  ): Promise<RoomMessage>;
  updateSettings(update: Partial<RoomSettings>): Promise<void>;
  changeTopic(topic: string): Promise<void>;
  updateParticipantStyle(participant: StyledParticipant, style: ChatStyle): Promise<void>;
  setSession(agent: AgentId, id: string, permission: "read-only" | "writable"): Promise<void>;
  clearSession(agent: AgentId): Promise<void>;
  setStatus(status: RoomState["status"], activeAgent?: AgentId, error?: string): Promise<void>;
}

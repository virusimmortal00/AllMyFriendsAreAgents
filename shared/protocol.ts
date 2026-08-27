export const ROOM_PROTOCOL_VERSION = 6;

export type ImplementationUnavailableReason =
  | "participant-ineligible"
  | "no-active-assignment"
  | "assignment-owner-mismatch"
  | "governance-invalid"
  | "confinement-unavailable";

export interface ImplementationCapability {
  eligible: boolean;
  available: boolean;
  unavailableReason?: ImplementationUnavailableReason;
}

export interface ServerIdentity {
  instanceId: string;
  protocolVersion: number;
}

export interface RoomProtocolPosition {
  streamId: string;
  version: number;
}

export interface RoomFullSnapshotEvent<State> extends RoomProtocolPosition {
  kind: "snapshot";
  reason: "initial" | "resync";
  continuity: "same-stream" | "fresh";
  fromVersion?: number;
  state: State;
}

export interface RoomStateDeltaEvent<State> extends RoomProtocolPosition {
  kind: "state-delta";
  fromVersion: number;
  state: Omit<State, "messages">;
}

export interface RoomMessagesAppendedEvent<Message> extends RoomProtocolPosition {
  kind: "messages-appended";
  fromVersion: number;
  messages: Message[];
}

export type RoomProtocolEvent<State extends { messages: Message[] }, Message = State["messages"][number]> =
  | RoomFullSnapshotEvent<State>
  | RoomStateDeltaEvent<State>
  | RoomMessagesAppendedEvent<Message>;

export interface MessageMutationAcknowledgement {
  accepted: true;
  duplicate: boolean;
  clientMessageId: string;
  messageId: string;
  continuation?: ContinuationInitiationOutcome;
}

export interface CommandMutationAcknowledgement {
  command: true;
  clientSubmissionId: string;
  /** Private command envelope; /help also has a durable server-authored invoker-only transcript projection. */
  result: { kind: "accepted" | "private-help" | "private-error"; commands?: string[]; message?: string; submissionId?: string; duplicate?: boolean; poll?: unknown };
}

export interface RoomContinuationWorkRequest {
  taskId: string;
  taskRevision: number;
  assignmentReferenceId: string;
  objective: string;
  budget?: Partial<{ timeMs: number; tokenLimit: number; toolCallLimit: number; retryLimit: number }>;
}

export type ContinuationInitiationOutcome =
  | { outcome: "queued"; jobId: string; status: string }
  | { outcome: "observed"; jobId: string; status: string }
  | { outcome: "rejected"; reason: string };

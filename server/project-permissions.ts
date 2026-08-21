import { agentScreenName, type WritableAgent } from "../shared/participants.js";

export interface ProjectPermissionActor {
  readonly id: string;
  readonly name: string;
}

export function projectPermissionAuditMessages(
  previous: WritableAgent,
  next: WritableAgent,
  actor: ProjectPermissionActor,
) {
  if (previous === next) return [];
  return [
    ...(previous === "nobody"
      ? []
      : [`${actor.name} revoked project write access from ${agentScreenName(previous)}.`]),
    ...(next === "nobody"
      ? []
      : [`${actor.name} granted project write access to ${agentScreenName(next)}.`]),
  ];
}

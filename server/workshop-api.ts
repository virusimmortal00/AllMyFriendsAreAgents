import type { RoomRepository } from "./storage/room-repository.js";
import { workshopEmergencyStop, workshopView } from "../shared/workshop.js";
import { listGovernedImprovements, readGovernedImprovement, type GovernedImprovementScope } from "./governed-improvement-api.js";

export async function listWorkshopImprovements(repository: RoomRepository, limit: number, scope: GovernedImprovementScope = "active") {
  const governed = await listGovernedImprovements(repository, scope);
  return {
    scope,
    items: governed.items.slice(0, Math.max(1, Math.min(50, limit))),
    emergencyStop: workshopEmergencyStop(await repository.getEmergencyStop()),
  };
}

export async function readWorkshopImprovement(repository: RoomRepository, id: string) {
  const improvement = await repository.getImprovement(id);
  if (!improvement) return undefined;
  const governance = await readGovernedImprovement(repository, id);
  if (governance.kind !== "found") return undefined;
  return {
    kind: "found" as const,
    ...governance.item,
    improvement: workshopView(improvement),
    emergencyStop: workshopEmergencyStop(await repository.getEmergencyStop()),
  };
}

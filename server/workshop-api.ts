import type { RoomRepository } from "./storage/room-repository.js";
import { workshopEmergencyStop, workshopView } from "../shared/workshop.js";

export async function listWorkshopImprovements(repository: RoomRepository, limit: number) {
  const page = await repository.listImprovements({ limit: Math.max(1, Math.min(50, limit)) });
  return { items: page.items.map(workshopView), nextCursor: page.nextCursor, emergencyStop: workshopEmergencyStop(await repository.getEmergencyStop()) };
}

export async function readWorkshopImprovement(repository: RoomRepository, id: string) {
  const improvement = await repository.getImprovement(id);
  return improvement ? { improvement: workshopView(improvement), emergencyStop: workshopEmergencyStop(await repository.getEmergencyStop()) } : undefined;
}

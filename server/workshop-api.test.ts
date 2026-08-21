import { describe, expect, it } from "vitest";
import { createImprovement } from "../shared/improvement-domain.js";
import { listWorkshopImprovements, readWorkshopImprovement } from "./workshop-api.js";

const improvement = createImprovement({ id: "room-safe", risk: "GUARDED", author: { id: "author", role: "AUTHOR", human: true }, now: "2026-08-21T12:00:00Z" });
const repository = {
  listImprovements: async () => ({ items: [improvement], nextCursor: null }),
  getImprovement: async (id: string) => id === improvement.id ? improvement : undefined,
  getEmergencyStop: async () => ({ revision: 4, active: true, activatedBy: "admin", activatedAt: "2026-08-21T13:00:00Z", reason: "Investigating" }),
};

describe("room workshop API", () => {
  it("returns bounded read-only views without execution payloads", async () => {
    const page = await listWorkshopImprovements(repository as never, 500);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: "room-safe", revision: 1, state: "DRAFT", risk: "GUARDED" });
    expect(JSON.stringify(page)).not.toContain("attribution");
    expect(JSON.stringify(page)).not.toContain("fencingToken");
    expect(page.emergencyStop).toEqual({ active: true, reason: "Investigating", activatedAt: "2026-08-21T13:00:00Z" });
  });
  it("handles unknown improvement references safely", async () => {
    await expect(readWorkshopImprovement(repository as never, "gone")).resolves.toBeUndefined();
  });
});

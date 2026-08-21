import { describe, expect, it } from "vitest";
import { improvementReferences, workshopView } from "./workshop.js";
import { createImprovement } from "./improvement-domain.js";

describe("workshop projections", () => {
  it("keeps execution manifests and attribution out of a room-safe projection", () => {
    const improvement = createImprovement({ id: "safe-1", risk: "LOW", author: { id: "a", role: "AUTHOR", human: true }, now: "2026-08-21T12:00:00Z" });
    expect(workshopView(improvement)).not.toHaveProperty("attribution");
    expect(JSON.stringify(workshopView(improvement))).not.toContain("promptReference");
  });
  it("parses only stable bracketed references", () => {
    expect(improvementReferences("See [[improvement:abc-1]]; improvement:nope.")).toEqual([{ id: "abc-1", start: 4, end: 25, label: "Improvement abc-1" }]);
    expect(improvementReferences("[[improvement:bad id]]")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { agentBehaviorContext } from "./agent-behavior.js";

describe("current turn behavior context", () => {
  it("uses the supplied instant's UTC date and weekday across midnight", () => {
    const before = agentBehaviorContext(new Date("2026-09-10T23:59:59Z"));
    const after = agentBehaviorContext(new Date("2026-09-11T00:00:00Z"));
    expect(before).toContain("2026-09-10T23:59:59.000Z — Thursday, UTC");
    expect(after).toContain("2026-09-11T00:00:00.000Z — Friday, UTC");
    expect(after).not.toContain("Thursday");
  });
});

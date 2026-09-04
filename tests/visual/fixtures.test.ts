import { describe, expect, it } from "vitest";
import { normalizeRoomAgentRoster } from "../../shared/roster";
import { VIEWS } from "../../src/view-registry";
import { visualRoster } from "./fixtures";
import { APP_SCENARIOS, expectedVisualKeys, VISUAL_SCENARIOS } from "./matrix";
import { appFixtureResponse, fixtureRoom } from "./app-fixtures";

describe("visual fixture fidelity", () => {
  it("retains the fictional roster through the production normalizer", () => {
    expect(normalizeRoomAgentRoster(visualRoster).entries.map((entry) => entry.agentId)).toEqual(visualRoster.entries.map((entry) => entry.agentId));
    expect(fixtureRoom.roster?.entries).toHaveLength(9);
  });
  it("explicitly maps every registered view and additional administration states", () => {
    expect(VISUAL_SCENARIOS.map((scenario) => scenario.view.id).sort()).toEqual([...Object.values(VIEWS), VIEWS.serverAdministration, VIEWS.serverAdministration, VIEWS.yourProfile, VIEWS.yourProfile, VIEWS.ownerDiagnosticsQuery, VIEWS.manageAgentsRoster].map((view) => view.id).sort());
    expect(new Set(APP_SCENARIOS.map((scenario) => scenario.id)).size).toBe(APP_SCENARIOS.length);
    expect(expectedVisualKeys()).toHaveLength(858);
    expect(expectedVisualKeys().filter((key) => key.includes("--compact-room-chat--"))).toHaveLength(6);
  });
  it("rejects unmocked external-state mutations", () => {
    expect(appFixtureResponse("/api/control/contributions/example/publish", "POST", "room-chat").status).toBe(501);
  });
});

import { describe, expect, it } from "vitest";
import {
  classifyStrictDiagnostic,
  isMigrationSlice,
  summarizeStrictDiagnostics,
  type StrictDiagnostic,
} from "./strict-type-inventory.js";

describe("strict type migration inventory", () => {
  it.each([
    ["shared/mentions.ts", "shared-contracts"],
    ["src/App.tsx", "client-runtime"],
    ["src/composer.test.tsx", "client-tests"],
    ["server/conversation.ts", "server-runtime"],
    ["server/storage/sqlite-room-repository.ts", "server-boundaries"],
    ["server/github-client.ts", "server-boundaries"],
    ["server/agent-runner.test.ts", "server-tests"],
    ["tests/visual/app-fixtures.ts", "visual-tooling"],
    ["scripts/review-visual.ts", "visual-tooling"],
    ["vite.config.ts", "unassigned"],
  ])("assigns %s to %s", (file, slice) => {
    expect(classifyStrictDiagnostic(file)).toBe(slice);
  });

  it("summarizes each option separately without losing the owned file count", () => {
    const diagnostic = (option: StrictDiagnostic["option"], file: string): StrictDiagnostic => ({
      option,
      projects: ["tsconfig.app.json"],
      file,
      line: 1,
      column: 1,
      code: 1234,
      message: "fixture",
      slice: classifyStrictDiagnostic(file),
    });
    const summary = summarizeStrictDiagnostics([
      diagnostic("exactOptionalPropertyTypes", "shared/mentions.ts"),
      diagnostic("noUncheckedIndexedAccess", "shared/mentions.ts"),
      diagnostic("noUncheckedIndexedAccess", "src/App.tsx"),
    ]);
    expect(summary.find((entry) => entry.slice === "shared-contracts")).toMatchObject({
      files: 1,
      exactOptionalPropertyTypes: 1,
      noUncheckedIndexedAccess: 1,
      total: 2,
    });
  });

  it("rejects misspelled slice identifiers", () => {
    expect(isMigrationSlice("shared-contracts")).toBe(true);
    expect(isMigrationSlice("shared-contract")).toBe(false);
  });
});

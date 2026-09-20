import { describe, expect, it } from "vitest";
import {
  findUncoveredTypeScriptFiles,
  isTypeScriptPath,
  missingRequiredCompilerOptions,
} from "./check-type-project-coverage.js";

describe("TypeScript project coverage guard", () => {
  it.each(["src/app.ts", "src/view.tsx", "scripts/tool.mts", "scripts/tool.cts", "release/runtime.d.mts"])(
    "recognizes %s as TypeScript",
    (file) => expect(isTypeScriptPath(file)).toBe(true),
  );

  it.each(["scripts/tool.mjs", "scripts/tool.js", "docs/types.md", "package.json"])(
    "ignores non-TypeScript path %s",
    (file) => expect(isTypeScriptPath(file)).toBe(false),
  );

  it("reports only TypeScript files outside every checked project", () => {
    const projects = new Map([
      ["app", new Set(["src/app.ts"])],
      ["scripts", new Set(["scripts/tool.ts"])],
    ]);
    expect(
      findUncoveredTypeScriptFiles(
        ["src/app.ts", "scripts/tool.ts", "scripts/new-tool.ts", "release/runtime.d.mts", "README.md"],
        projects,
      ),
    ).toEqual(["release/runtime.d.mts", "scripts/new-tool.ts"]);
  });

  it("requires the complete repository strictness policy", () => {
    expect(
      missingRequiredCompilerOptions({
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noFallthroughCasesInSwitch: true,
      }),
    ).toEqual([]);
    expect(missingRequiredCompilerOptions({ strict: true })).toEqual([
      "exactOptionalPropertyTypes",
      "noUncheckedIndexedAccess",
      "noImplicitOverride",
      "noFallthroughCasesInSwitch",
    ]);
  });
});

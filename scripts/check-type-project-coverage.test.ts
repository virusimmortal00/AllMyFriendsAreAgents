import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  filterExistingPaths,
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

  it("excludes deleted cached paths while retaining existing untracked files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-type-coverage-"));
    try {
      await writeFile(path.join(root, "tracked.ts"), "export {};\n", "utf8");
      await writeFile(path.join(root, "untracked.ts"), "export {};\n", "utf8");
      expect(filterExistingPaths(root, ["tracked.ts", "deleted.ts", "untracked.ts"])).toEqual([
        "tracked.ts",
        "untracked.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

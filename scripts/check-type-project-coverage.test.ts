import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  filterExistingPaths,
  findUncoveredTypeScriptFiles,
  isTypeScriptPath,
  missingRequiredCompilerOptions,
  sourcePathsForCoverage,
  sourcePathsWithoutGit,
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

  it("uses only source paths when Git metadata is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-type-coverage-"));
    try {
      await writeFile(path.join(root, "src.ts"), "export {};\n", "utf8");
      await writeFile(path.join(root, "notes.md"), "Notes\n", "utf8");
      await Promise.all(["node_modules", "dist", ".runtime"].map((directory) => mkdir(path.join(root, directory))));
      await writeFile(path.join(root, "node_modules", "dependency.ts"), "export {};\n", "utf8");
      await writeFile(path.join(root, "dist", "generated.ts"), "export {};\n", "utf8");
      await writeFile(path.join(root, ".runtime", "generated.ts"), "export {};\n", "utf8");
      await mkdir(path.join(root, "linked-directory"));
      await writeFile(path.join(root, "linked-directory", "nested.ts"), "export {};\n", "utf8");
      await symlink("src.ts", path.join(root, "linked.ts"));
      await symlink("linked-directory", path.join(root, "linked-directory-link"));
      expect(sourcePathsWithoutGit(root)).toEqual([
        "linked-directory-link",
        "linked-directory/nested.ts",
        "linked.ts",
        "notes.md",
        "src.ts",
      ]);
      expect(sourcePathsForCoverage(root)).toEqual([
        "linked-directory-link",
        "linked-directory/nested.ts",
        "linked.ts",
        "notes.md",
        "src.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires the complete repository strictness policy", () => {
    expect(
      missingRequiredCompilerOptions({
        strict: true,
        strictNullChecks: true,
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
    expect(
      missingRequiredCompilerOptions({
        strict: true,
        strictNullChecks: false,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noFallthroughCasesInSwitch: true,
      }),
    ).toEqual(["strictNullChecks"]);
  });
});

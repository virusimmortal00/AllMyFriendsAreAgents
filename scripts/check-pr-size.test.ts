import { describe, expect, it } from "vitest";
import {
  evaluatePullRequestSize,
  MAX_CHANGED_LINES,
  MAX_FILE_COUNT,
  parseNumstat,
  PREFERRED_CHANGED_LINES,
  PREFERRED_FILE_COUNT,
} from "./check-pr-size.js";

describe("pull request size guard", () => {
  it("counts text and binary files without inventing binary line totals", () => {
    expect(parseNumstat("12\t3\tsrc/app.ts\n-\t-\tpublic/image.png\n0\t4\tdocs/old.md\n")).toEqual({
      additions: 12,
      changedFiles: 3,
      changedLines: 19,
      deletions: 7,
    });
  });

  it("accepts a focused change without diagnostics", () => {
    expect(evaluatePullRequestSize({ additions: 10, changedFiles: 2, changedLines: 15, deletions: 5 })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("warns above the preferred review target", () => {
    const result = evaluatePullRequestSize({
      additions: PREFERRED_CHANGED_LINES,
      changedFiles: PREFERRED_FILE_COUNT + 1,
      changedLines: PREFERRED_CHANGED_LINES + 1,
      deletions: 1,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it("fails above either hard reviewability limit", () => {
    const result = evaluatePullRequestSize({
      additions: MAX_CHANGED_LINES,
      changedFiles: MAX_FILE_COUNT + 1,
      changedLines: MAX_CHANGED_LINES + 1,
      deletions: 1,
    });
    expect(result.warnings).toEqual([]);
    expect(result.errors).toHaveLength(2);
  });
});

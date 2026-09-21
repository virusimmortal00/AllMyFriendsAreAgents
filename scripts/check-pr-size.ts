import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PREFERRED_FILE_COUNT = 50;
export const PREFERRED_CHANGED_LINES = 1_000;
export const MAX_FILE_COUNT = 100;
export const MAX_CHANGED_LINES = 5_000;

export interface PullRequestSize {
  additions: number;
  changedFiles: number;
  changedLines: number;
  deletions: number;
}

export interface PullRequestSizeResult {
  errors: string[];
  warnings: string[];
}

export function parseNumstat(output: string): PullRequestSize {
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;

  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const [added, deleted] = line.split("\t");
    if (added === undefined || deleted === undefined) {
      throw new Error(`Unexpected git diff --numstat line: ${line}`);
    }

    changedFiles += 1;
    if (added !== "-") additions += Number.parseInt(added, 10);
    if (deleted !== "-") deletions += Number.parseInt(deleted, 10);
  }

  return {
    additions,
    changedFiles,
    changedLines: additions + deletions,
    deletions,
  };
}

export function evaluatePullRequestSize(size: PullRequestSize): PullRequestSizeResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (size.changedFiles > MAX_FILE_COUNT) {
    errors.push(`changes ${size.changedFiles} files; the hard limit is ${MAX_FILE_COUNT}`);
  } else if (size.changedFiles > PREFERRED_FILE_COUNT) {
    warnings.push(`changes ${size.changedFiles} files; the preferred maximum is ${PREFERRED_FILE_COUNT}`);
  }

  if (size.changedLines > MAX_CHANGED_LINES) {
    errors.push(`changes ${size.changedLines} lines; the hard limit is ${MAX_CHANGED_LINES}`);
  } else if (size.changedLines > PREFERRED_CHANGED_LINES) {
    warnings.push(`changes ${size.changedLines} lines; the preferred maximum is ${PREFERRED_CHANGED_LINES}`);
  }

  return { errors, warnings };
}

function argumentValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function run(): void {
  const base = argumentValue("base") ?? process.env.PR_SIZE_BASE_SHA;
  const head = argumentValue("head") ?? process.env.PR_SIZE_HEAD_SHA ?? "HEAD";
  if (base === undefined) {
    throw new Error("Provide --base=<revision> or PR_SIZE_BASE_SHA so the pull request diff is measured exactly.");
  }

  const mergeBase = git("merge-base", base, head);
  const size = parseNumstat(git("diff", "--numstat", "--find-renames", `${mergeBase}..${head}`));
  const result = evaluatePullRequestSize(size);
  const summary = `${size.changedFiles} files, ${size.changedLines} changed lines (+${size.additions}/-${size.deletions})`;
  console.log(`Pull request size: ${summary}`);

  for (const warning of result.warnings) {
    console.warn(process.env.GITHUB_ACTIONS === "true" ? `::warning::${warning}` : `Warning: ${warning}`);
  }

  if (result.errors.length > 0) {
    throw new Error(
      `Pull request exceeds the reviewability budget:\n- ${result.errors.join("\n- ")}\nSplit the work into dependency-ordered stacked pull requests and run the full quality gate for every layer.`,
    );
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) run();

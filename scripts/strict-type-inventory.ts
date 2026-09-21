import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const STRICT_OPTIONS = ["exactOptionalPropertyTypes", "noUncheckedIndexedAccess"] as const;
export type StrictOption = (typeof STRICT_OPTIONS)[number];

export const MIGRATION_SLICES = [
  "shared-contracts",
  "client-runtime",
  "client-tests",
  "server-runtime",
  "server-boundaries",
  "server-tests",
  "visual-tooling",
] as const;
export type MigrationSlice = (typeof MIGRATION_SLICES)[number];

export function isMigrationSlice(value: string): value is MigrationSlice {
  return (MIGRATION_SLICES as readonly string[]).includes(value);
}

const PROJECTS = ["tsconfig.app.json", "tsconfig.node.json", "tsconfig.visual.json"] as const;
const SERVER_BOUNDARY_FILES = new Set([
  "server/command-api.ts",
  "server/command-runtime.ts",
  "server/git-broker-server.ts",
  "server/project-repository-api.ts",
  "server/project-repository-connection.ts",
  "server/source-control-adapter.ts",
]);

export interface StrictDiagnostic {
  option: StrictOption;
  projects: string[];
  file: string;
  line: number;
  column: number;
  code: number;
  message: string;
  slice: MigrationSlice | "unassigned";
}

export function classifyStrictDiagnostic(file: string): StrictDiagnostic["slice"] {
  const normalized = file.replaceAll("\\", "/");
  if (normalized.startsWith("shared/")) return "shared-contracts";
  if (normalized.startsWith("tests/visual/") || normalized.startsWith("scripts/")) return "visual-tooling";
  if (normalized.startsWith("src/")) return /\.test\.tsx?$/.test(normalized) ? "client-tests" : "client-runtime";
  if (normalized.startsWith("server/")) {
    if (/\.test\.tsx?$/.test(normalized)) return "server-tests";
    const basename = path.posix.basename(normalized);
    if (
      normalized.startsWith("server/storage/") ||
      basename.includes("github") ||
      basename.startsWith("openrouter") ||
      basename.startsWith("opencode") ||
      SERVER_BOUNDARY_FILES.has(normalized)
    )
      return "server-boundaries";
    return "server-runtime";
  }
  return "unassigned";
}

export function summarizeStrictDiagnostics(diagnostics: readonly StrictDiagnostic[]) {
  return MIGRATION_SLICES.map((slice) => {
    const owned = diagnostics.filter((diagnostic) => diagnostic.slice === slice);
    return {
      slice,
      files: new Set(owned.map((diagnostic) => diagnostic.file)).size,
      exactOptionalPropertyTypes: owned.filter((diagnostic) => diagnostic.option === "exactOptionalPropertyTypes")
        .length,
      noUncheckedIndexedAccess: owned.filter((diagnostic) => diagnostic.option === "noUncheckedIndexedAccess").length,
      total: owned.length,
    };
  });
}

function readProject(root: string, project: string, option: StrictOption) {
  const configPath = path.join(root, project);
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    root,
    {
      noEmit: true,
      exactOptionalPropertyTypes: option === "exactOptionalPropertyTypes",
      noUncheckedIndexedAccess: option === "noUncheckedIndexedAccess",
    },
    configPath,
  );
  if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, formatHost(root)));
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  return ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
}

function formatHost(root: string): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  };
}

export function collectStrictDiagnostics(root: string): StrictDiagnostic[] {
  const collected = new Map<string, StrictDiagnostic>();
  for (const option of STRICT_OPTIONS) {
    for (const project of PROJECTS) {
      for (const diagnostic of readProject(root, project, option)) {
        if (!diagnostic.file || diagnostic.start === undefined) continue;
        const file = path.relative(root, diagnostic.file.fileName).replaceAll("\\", "/");
        if (project === "tsconfig.visual.json" && !file.startsWith("tests/visual/") && !file.startsWith("scripts/"))
          continue;
        const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
        const key = [option, file, diagnostic.start, diagnostic.code, message].join("\0");
        const existing = collected.get(key);
        if (existing) {
          if (!existing.projects.includes(project)) existing.projects.push(project);
          continue;
        }
        collected.set(key, {
          option,
          projects: [project],
          file,
          line: position.line + 1,
          column: position.character + 1,
          code: diagnostic.code,
          message,
          slice: classifyStrictDiagnostic(file),
        });
      }
    }
  }
  return [...collected.values()].sort(
    (left, right) =>
      left.slice.localeCompare(right.slice) ||
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.option.localeCompare(right.option),
  );
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printText(diagnostics: readonly StrictDiagnostic[], selectedSlice?: string) {
  process.stdout.write("Strict TypeScript migration inventory\n");
  process.stdout.write("Options are evaluated separately so each diagnostic retains its semantic cause.\n\n");
  for (const summary of summarizeStrictDiagnostics(diagnostics)) {
    process.stdout.write(
      `${summary.slice}: ${summary.total} diagnostics in ${summary.files} files ` +
        `(exact optional: ${summary.exactOptionalPropertyTypes}, unchecked index: ${summary.noUncheckedIndexedAccess})\n`,
    );
  }
  const unassigned = diagnostics.filter((diagnostic) => diagnostic.slice === "unassigned");
  process.stdout.write(`unassigned: ${unassigned.length}\n`);
  if (!selectedSlice) return;
  process.stdout.write(`\nDiagnostics for ${selectedSlice}:\n`);
  for (const diagnostic of diagnostics.filter((item) => item.slice === selectedSlice)) {
    process.stdout.write(
      `- ${diagnostic.file}:${diagnostic.line}:${diagnostic.column} TS${diagnostic.code} ` +
        `[${diagnostic.option}] ${diagnostic.message}\n`,
    );
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const diagnostics = collectStrictDiagnostics(root);
  const selectedSlice = argument("slice");
  const assertClean = argument("assert-clean");
  const unassigned = diagnostics.filter((diagnostic) => diagnostic.slice === "unassigned");

  if (selectedSlice && !isMigrationSlice(selectedSlice)) {
    throw new Error(`Unknown migration slice ${selectedSlice}. Expected one of: ${MIGRATION_SLICES.join(", ")}`);
  }
  if (assertClean && assertClean !== "all" && !isMigrationSlice(assertClean)) {
    throw new Error(`Unknown migration slice ${assertClean}. Expected all or one of: ${MIGRATION_SLICES.join(", ")}`);
  }

  if (process.argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, summary: summarizeStrictDiagnostics(diagnostics), diagnostics }, null, 2)}\n`,
    );
  } else {
    printText(diagnostics, selectedSlice);
  }

  if (unassigned.length) {
    process.stderr.write(
      "Strict diagnostics exist outside every declared migration slice; update the inventory before continuing.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (assertClean) {
    const remaining =
      assertClean === "all" ? diagnostics : diagnostics.filter((diagnostic) => diagnostic.slice === assertClean);
    if (remaining.length) {
      process.stderr.write(`${assertClean} still has ${remaining.length} strict diagnostics.\n`);
      process.exitCode = 1;
    }
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

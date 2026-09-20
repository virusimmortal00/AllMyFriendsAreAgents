import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const TYPECHECK_PROJECTS = [
  "tsconfig.app.json",
  "tsconfig.node.json",
  "tsconfig.visual.json",
  "tsconfig.scripts.json",
  "tsconfig.strict-inventory.json",
] as const;

export const REQUIRED_COMPILER_OPTIONS = [
  "strict",
  "exactOptionalPropertyTypes",
  "noUncheckedIndexedAccess",
  "noImplicitOverride",
  "noFallthroughCasesInSwitch",
] as const satisfies readonly (keyof ts.CompilerOptions)[];

export function isTypeScriptPath(file: string): boolean {
  return /\.(?:[cm]?ts|tsx)$/.test(file);
}

export function findUncoveredTypeScriptFiles(
  files: readonly string[],
  projectFiles: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const covered = new Set([...projectFiles.values()].flatMap((paths) => [...paths]));
  return files.filter(isTypeScriptPath).filter((file) => !covered.has(file)).sort();
}

export function filterExistingPaths(root: string, files: readonly string[]): string[] {
  return files.filter((file) => existsSync(path.join(root, file)));
}

export function missingRequiredCompilerOptions(options: ts.CompilerOptions): string[] {
  return REQUIRED_COMPILER_OPTIONS.filter((option) => options[option] !== true);
}

function projectFiles(root: string, project: string): { files: Set<string>; options: ts.CompilerOptions } {
  const configPath = path.join(root, project);
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, {}, configPath);
  if (parsed.errors.length) {
    throw new Error(
      ts.formatDiagnostics(parsed.errors, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }),
    );
  }
  return {
    files: new Set(parsed.fileNames.map((file) => path.relative(root, file).replaceAll("\\", "/"))),
    options: parsed.options,
  };
}

export function checkTypeProjectCoverage(root: string): {
  trackedFiles: string[];
  projects: Map<string, Set<string>>;
} {
  const trackedFiles = filterExistingPaths(
    root,
    execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
      .map((file) => file.replaceAll("\\", "/")),
  );
  const projects = new Map<string, Set<string>>();
  const configurationFailures: string[] = [];
  for (const project of TYPECHECK_PROJECTS) {
    const parsed = projectFiles(root, project);
    projects.set(project, parsed.files);
    const missing = missingRequiredCompilerOptions(parsed.options);
    if (missing.length) configurationFailures.push(`${project}: ${missing.join(", ")}`);
  }
  if (configurationFailures.length) {
    throw new Error(`TypeScript projects are missing required strict options:\n- ${configurationFailures.join("\n- ")}`);
  }
  const uncovered = findUncoveredTypeScriptFiles(trackedFiles, projects);
  if (uncovered.length) {
    throw new Error(`TypeScript files are outside every checked project:\n- ${uncovered.join("\n- ")}`);
  }
  return { trackedFiles: trackedFiles.filter(isTypeScriptPath), projects };
}

function main(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = checkTypeProjectCoverage(root);
  process.stdout.write(
    `TypeScript project coverage passed: ${result.trackedFiles.length} files across ${result.projects.size} strict projects.\n`,
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();

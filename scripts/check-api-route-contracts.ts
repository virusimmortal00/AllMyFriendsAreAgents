import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { API_ROOTS, API_ROUTES } from "../shared/api-routes.js";
import type { ApiRouteDefinition, ApiRootDefinition, ApiRootScope } from "../shared/api-routes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = path.join(ROOT, "server");
const SRC_DIR = path.join(ROOT, "src");
const CLIENT_API_FILE = path.join(SRC_DIR, "api.ts");

/** Marks an interpolated path segment; normalized to the ":*" wildcard. */
const INTERPOLATION = "\u0000";
const ROUTE_METHODS: Record<string, true> = { get: true, post: true, put: true, patch: true, delete: true };
const ROOM_PATH_ENDPOINTS: Record<string, true> = { state: true, messages: true, events: true };
const ROOM_PREFIX = "/api/rooms/:roomId";

export interface ObservedRoute {
  readonly method: string;
  readonly path: string;
  readonly file: string;
  readonly line: number;
}

export interface SourceProblem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface ClientRequestCall {
  readonly raw: string;
  readonly variants: readonly string[];
  readonly method?: string;
  readonly file: string;
  readonly line: number;
}

export interface RouteContractReport {
  readonly failures: readonly string[];
  readonly knownGaps: readonly string[];
}

function literalOf(expression: ts.Expression): string | null {
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) ? expression.text : null;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

/** Extracts static Express registrations such as app.get("/api/tasks/:taskId", handler). */
export function extractServerRoutes(text: string, file: string): { routes: ObservedRoute[]; problems: SourceProblem[] } {
  const sourceFile = parse(file, text);
  const routes: ObservedRoute[] = [];
  const problems: SourceProblem[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ROUTE_METHODS[node.expression.name.text]) {
      const first = node.arguments[0];
      if (first) {
        const literal = literalOf(first);
        if (literal !== null) {
          if (literal.startsWith("/api")) routes.push({ method: node.expression.name.text.toUpperCase(), path: literal, file, line: lineOf(sourceFile, node) });
        } else if (ts.isTemplateExpression(first) && first.head.text.startsWith("/api")) {
          problems.push({ file, line: lineOf(sourceFile, node), message: `dynamic route path ${JSON.stringify(first.head.text)}… cannot be verified; route paths must be static literals` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { routes, problems };
}

/** Strips query strings and normalizes interpolations: a segment interpolation becomes ":*", a suffix fused onto a segment (a query-string variable) is truncated. */
export function normalizeClientPath(raw: string): string {
  const withoutQuery = raw.includes("?") ? raw.slice(0, raw.indexOf("?")) : raw;
  let normalized = "";
  for (const char of withoutQuery) {
    if (char === INTERPOLATION) {
      if (normalized.endsWith("/")) normalized += ":*";
      else return normalized;
    } else normalized += char;
  }
  return normalized;
}

function templateRaw(node: ts.TemplateExpression): string {
  let raw = node.head.text;
  for (const span of node.templateSpans) raw += INTERPOLATION + span.literal.text;
  return raw;
}

function literalUnionValues(typeNode: ts.TypeNode): string[] | null {
  if (ts.isLiteralTypeNode(typeNode) && ts.isStringLiteral(typeNode.literal)) return [typeNode.literal.text];
  if (ts.isUnionTypeNode(typeNode)) {
    const members = typeNode.types.map(literalUnionValues);
    return members.every((member) => member !== null) ? members.flat() : null;
  }
  return null;
}

/** Resolves a request() identifier argument to the literal union of its innermost enclosing parameter declaration. */
function resolveArgumentLiterals(node: ts.CallExpression, identifier: ts.Identifier): string[] | null {
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    if (ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope) || ts.isArrowFunction(scope) || ts.isMethodDeclaration(scope)) {
      for (const parameter of scope.parameters) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text && parameter.type) return literalUnionValues(parameter.type);
      }
    }
  }
  return null;
}

function segmentsOf(routePath: string): string[] {
  return routePath.split("/").filter(Boolean);
}

/** Structural match: static segments must be equal; an interpolated client segment matches any segment and a literal matches a ":param". */
export function matchesRoutePattern(clientPath: string, routePath: string): boolean {
  const left = segmentsOf(clientPath);
  const right = segmentsOf(routePath);
  return left.length === right.length && left.every((segment, index) => segment === right[index] || segment === ":*" || right[index].startsWith(":"));
}

function methodOfCall(sourceFile: ts.SourceFile, node: ts.CallExpression): { method?: string } {
  const options = node.arguments[1];
  if (options && ts.isObjectLiteralExpression(options)) {
    for (const property of options.properties) {
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "method" && ts.isStringLiteral(property.initializer)) {
        return { method: property.initializer.text.toUpperCase() };
      }
    }
  }
  return {};
}

/** Extracts browser client calls: request("…") / request(`/api/…`) / request(roomPath("state"), …) plus standalone roomPath(…) wrappers. */
export function extractClientRequests(text: string, file: string): { calls: ClientRequestCall[]; problems: SourceProblem[] } {
  const sourceFile = parse(file, text);
  const calls: ClientRequestCall[] = [];
  const problems: SourceProblem[] = [];
  const roomPathEndpoint = (node: ts.CallExpression): string | null => {
    const argument = node.arguments[0];
    if (!argument || !ts.isIdentifier(node.expression) || node.expression.text !== "roomPath") return null;
    const literal = literalOf(argument);
    if (literal === null) {
      problems.push({ file, line: lineOf(sourceFile, node), message: "roomPath must be called with a static endpoint literal" });
      return null;
    }
    if (!ROOM_PATH_ENDPOINTS[literal]) {
      problems.push({ file, line: lineOf(sourceFile, node), message: `roomPath endpoint ${JSON.stringify(literal)} is outside the known endpoint set` });
      return null;
    }
    return literal;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const endpoint = roomPathEndpoint(node);
      if (endpoint) {
        const isRequestArgument = ts.isCallExpression(node.parent) && ts.isIdentifier(node.parent.expression) && node.parent.expression.text === "request" && node.parent.arguments[0] === node;
        const method = isRequestArgument ? methodOfCall(sourceFile, node.parent) : { method: "GET" };
        calls.push({ raw: `roomPath("${endpoint}")`, variants: [`/api/${endpoint}`, `${ROOM_PREFIX}/${endpoint}`], method: method.method, file, line: lineOf(sourceFile, node) });
      } else if (node.arguments.length && ts.isIdentifier(node.expression) && node.expression.text === "request") {
        const argument = node.arguments[0];
        const method = methodOfCall(sourceFile, node);
        const literal = literalOf(argument);
        const raw = literal !== null ? literal : ts.isTemplateExpression(argument) ? templateRaw(argument) : ts.isIdentifier(argument) ? resolveArgumentLiterals(node, argument) : null;
        if (typeof raw === "string" && raw.startsWith("/api")) {
          calls.push({ raw, variants: [normalizeClientPath(raw)], method: method.method, file, line: lineOf(sourceFile, node) });
        } else if (Array.isArray(raw)) {
          for (const value of raw) calls.push({ raw: value, variants: [value], method: method.method, file, line: lineOf(sourceFile, node) });
        } else if (raw === null && !(ts.isCallExpression(argument) && ts.isIdentifier(argument.expression) && argument.expression.text === "roomPath")) {
          problems.push({ file, line: lineOf(sourceFile, node), message: "request must be called with a static /api path or template, roomPath(endpoint), or a parameter typed as /api literals" });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { calls, problems };
}

/** Any /api string literal outside src/api.ts in browser code bypasses the shared client boundary. */
export function extractBoundaryViolations(text: string, file: string): SourceProblem[] {
  const sourceFile = parse(file, text);
  const problems: SourceProblem[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.includes("/api/")) {
      problems.push({ file, line: lineOf(sourceFile, node), message: "browser code must call the shared client boundary in src/api.ts, not raw /api paths" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return problems;
}

export function routeRoot(routePath: string): string | undefined {
  const segments = routePath.split("/").filter(Boolean);
  return segments.length >= 2 ? segments[1] : undefined;
}

function isRoomForm(routePath: string): boolean {
  return routePath.startsWith(`${ROOM_PREFIX}/`);
}

function roomFormOf(routePath: string): string {
  return `${ROOM_PREFIX}${routePath.slice("/api".length)}`;
}

function bareFormOf(routePath: string): string {
  return `/api${routePath.slice(ROOM_PREFIX.length)}`;
}

export interface RouteContractTable {
  readonly roots: readonly ApiRootDefinition[];
  readonly routes: readonly ApiRouteDefinition[];
}

/** Validates registry shape, server equality, room-twin completeness, and client coverage. */
export function checkRouteContracts(table: RouteContractTable, observed: readonly ObservedRoute[], observedProblems: readonly SourceProblem[], clientCalls: readonly ClientRequestCall[], clientProblems: readonly SourceProblem[], boundaryProblems: readonly SourceProblem[]): RouteContractReport {
  const failures: string[] = [];
  const knownGaps: string[] = [];
  for (const problem of [...observedProblems, ...clientProblems, ...boundaryProblems]) failures.push(`${problem.file.replace(`${ROOT}/`, "")}:${problem.line}: ${problem.message}`);

  const scopeByRoot = new Map<string, ApiRootScope>();
  for (const root of table.roots) {
    if (scopeByRoot.has(root.root)) failures.push(`api root ${JSON.stringify(root.root)} is classified more than once`);
    if (root.scope === "canonical" && (!root.note || root.note.trim().length === 0)) failures.push(`canonical api root ${JSON.stringify(root.root)} requires a note explaining the missing room-scoped twin`);
    scopeByRoot.set(root.root, root.scope);
  }

  const routeKeys = new Set(table.routes.map((route) => `${route.method} ${route.path}`));
  if (routeKeys.size !== table.routes.length) failures.push("shared/api-routes.ts contains duplicate method+path rows");
  for (const route of table.routes) {
    if (!route.path.startsWith("/api/") || route.path !== route.path.trim()) failures.push(`contract path ${JSON.stringify(route.path)} is not a normalized /api path`);
    const root = routeRoot(route.path);
    if (!root || !scopeByRoot.has(root)) failures.push(`route ${route.method} ${route.path} has no api root classification for ${JSON.stringify(root)}`);
  }

  const observedByKey = new Map(observed.map((route) => [`${route.method} ${route.path}`, route]));
  for (const [key, route] of observedByKey) {
    if (!routeKeys.has(key)) failures.push(`unregistered route ${key} at ${route.file.replace(`${ROOT}/`, "")}:${route.line} — add it to shared/api-routes.ts or remove it`);
  }
  for (const route of table.routes) {
    if (!observedByKey.has(`${route.method} ${route.path}`)) failures.push(`contract ${route.method} ${route.path} matches no server registration`);
  }

  const routesByRoot = new Map<string, ApiRouteDefinition[]>();
  for (const route of table.routes) {
    const root = routeRoot(route.path);
    if (root) routesByRoot.set(root, [...(routesByRoot.get(root) ?? []), route]);
  }
  for (const [root, scope] of scopeByRoot) {
    const routes = routesByRoot.get(root) ?? [];
    const bareRoutes = routes.filter((route) => !isRoomForm(route.path) && !routeKeys.has(`${route.method} ${roomFormOf(route.path)}`));
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (isRoomForm(route.path)) {
        const bareRoot = routeRoot(bareFormOf(route.path));
        if (scopeByRoot.get(bareRoot ?? "") === "room" && !routeKeys.has(`${route.method} ${bareFormOf(route.path)}`)) failures.push(`room-form ${key} has no bare twin under /api`);
      } else if (scope === "room" && !routeKeys.has(`${route.method} ${roomFormOf(route.path)}`)) {
        failures.push(`room-scoped route ${key} has no /api/rooms/:roomId twin`);
      }
    }
    if (scope === "canonical" && bareRoutes.length > 0) knownGaps.push(`${root}: ${bareRoutes.length} route(s) are canonical-room only; /rooms/:roomId views rewrite ${root} calls to a room form that would 404 until #60 lands per-room twins`);
    const roomFormCount = routes.filter((route) => isRoomForm(route.path)).length;
    if (root !== "rooms" && scope !== "room" && roomFormCount > 0) knownGaps.push(`${root} scope ${scope}: ${roomFormCount} room-form route(s) exist while the root is not fully classified "room" (partial twin coverage)`);
  }

  for (const call of clientCalls) {
    const match = table.routes.find((route) => call.variants.some((variant) => matchesRoutePattern(variant, route.path)) && (!call.method || route.method === call.method));
    if (!match) {
      failures.push(`client call ${JSON.stringify(call.raw)}${call.method ? ` (${call.method})` : ""} at ${call.file.replace(`${ROOT}/`, "")}:${call.line} matches no registered route`);
    }
  }

  return { failures, knownGaps };
}

function listSourceFiles(directory: string, suffixes: readonly string[]): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); }
      else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix)) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx") && !entry.name.endsWith(".d.ts")) files.push(full);
    }
  };
  walk(directory);
  return files.sort();
}

async function main(): Promise<void> {
  const observed: ObservedRoute[] = [];
  const observedProblems: SourceProblem[] = [];
  for (const file of listSourceFiles(SERVER_DIR, [".ts"])) {
    const { routes, problems } = extractServerRoutes(readFileSync(file, "utf8"), file);
    observed.push(...routes);
    observedProblems.push(...problems);
  }

  if (process.argv.includes("--emit-routes")) {
    for (const route of [...observed].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
      process.stdout.write(`${route.method} ${route.path}\n`);
    }
    for (const problem of observedProblems) process.stderr.write(`${problem.file}:${problem.line}: ${problem.message}\n`);
    return;
  }

  const clientResult = extractClientRequests(readFileSync(CLIENT_API_FILE, "utf8"), CLIENT_API_FILE);
  const boundaryProblems: SourceProblem[] = [];
  for (const file of listSourceFiles(SRC_DIR, [".ts", ".tsx"])) {
    if (file !== CLIENT_API_FILE) boundaryProblems.push(...extractBoundaryViolations(readFileSync(file, "utf8"), file));
  }

  const { failures, knownGaps } = checkRouteContracts({ roots: API_ROOTS, routes: API_ROUTES }, observed, observedProblems, clientResult.calls, clientResult.problems, boundaryProblems);
  for (const gap of knownGaps) process.stdout.write(`known gap: ${gap}\n`);
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`api route contract violation: ${failure}\n`);
    process.stderr.write(`${failures.length} violation(s). Update shared/api-routes.ts, the server registration, or src/api.ts together in the same change.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`api route contracts verified: ${observed.length} server routes, ${clientResult.calls.length} client call sites, ${knownGaps.length} known tracked gap(s).\n`);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();

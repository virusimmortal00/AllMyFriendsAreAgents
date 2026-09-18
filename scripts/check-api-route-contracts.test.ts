import { describe, expect, it } from "vitest";
import {
  checkRouteContracts,
  extractBoundaryViolations,
  extractClientRequests,
  extractServerRoutes,
  matchesRoutePattern,
  normalizeClientPath,
  type ClientRequestCall,
  type ObservedRoute,
  type RouteContractTable,
  type SourceProblem,
} from "./check-api-route-contracts.js";
import type { ApiRootDefinition, ApiRouteDefinition } from "../shared/api-routes.js";

const table = (roots: readonly ApiRootDefinition[], routes: readonly ApiRouteDefinition[]): RouteContractTable => ({ roots, routes });
const noProblems: readonly SourceProblem[] = [];
const noCalls: readonly ClientRequestCall[] = [];

const FULL_ROOTS: readonly ApiRootDefinition[] = [
  { root: "tasks", scope: "canonical", note: "per-room task storage is pending" },
  { root: "messages", scope: "room" },
  { root: "rooms", scope: "global" },
  { root: "control", scope: "global" },
];

const FULL_ROUTES: readonly ApiRouteDefinition[] = [
  { method: "GET", path: "/api/tasks" },
  { method: "POST", path: "/api/tasks" },
  { method: "GET", path: "/api/tasks/:taskId" },
  { method: "GET", path: "/api/messages" },
  { method: "GET", path: "/api/rooms/:roomId/messages" },
  { method: "GET", path: "/api/control/status" },
];

const observed = (routes: readonly { method: string; path: string }[]): ObservedRoute[] => routes.map((route) => ({ ...route, file: "/repo/server/example-api.ts", line: 1 }));

describe("client path normalization and matching", () => {
  it("maps an interpolated segment onto an Express :param and rejects static mismatches", () => {
    expect(matchesRoutePattern("/api/tasks/:*", "/api/tasks/:taskId")).toBe(true);
    expect(matchesRoutePattern("/api/tasks/task-1", "/api/tasks/:taskId")).toBe(true);
    expect(matchesRoutePattern("/api/tasks/task-1", "/api/tasks")).toBe(false);
    expect(matchesRoutePattern("/api/tasks", "/api/tasks/:taskId")).toBe(false);
    expect(matchesRoutePattern("/api/polls/:*/votes", "/api/polls/:pollId/votes")).toBe(true);
    expect(matchesRoutePattern("/api/polls/:*/close", "/api/polls/:pollId/votes")).toBe(false);
  });

  it("truncates a query-string interpolation fused onto a segment and strips explicit query strings", () => {
    expect(normalizeClientPath("/api/control/integrations/openrouter\u0000")).toBe("/api/control/integrations/openrouter");
    expect(normalizeClientPath("/api/improvements?scope=active&limit=50")).toBe("/api/improvements");
    expect(normalizeClientPath("/api/tasks/:*")).toBe("/api/tasks/:*");
  });
});

describe("server route extraction", () => {
  it("collects literal registrations on any receiver and ignores non-API paths", () => {
    const text = `
      app.get("/api/tasks", handler);
      input.app.post("/api/tasks/:taskId/complete", handler);
      router.patch("/api/settings", handler);
      app.get("/assets/style.css", handler);
    `;
    const { routes, problems } = extractServerRoutes(text, "server/example-api.ts");
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /api/tasks",
      "POST /api/tasks/:taskId/complete",
      "PATCH /api/settings",
    ]);
    expect(problems).toEqual([]);
  });

  it("rejects interpolated route paths so registrations cannot silently escape the contract", () => {
    const { routes, problems } = extractServerRoutes('app.get(`/api/${kind}`, handler);', "server/example-api.ts");
    expect(routes).toEqual([]);
    expect(problems[0]?.message).toContain("route paths must be static literals");
  });
});

describe("client call extraction", () => {
  it("collects literal, template, roomPath, and literal-union calls with their methods", () => {
    const text = `
      request("/api/roster", { method: "GET", cache: "no-store" });
      request(\`/api/polls/\${pollId}/close\`, { method: "POST", body: "{}" });
      request(roomPath("state"), { method: "GET" });
      function mutate(path: "/api/control/login" | "/api/control/bootstrap", body: object) {
        return request(path, { method: "POST", body: JSON.stringify(body) });
      }
    `;
    const { calls, problems } = extractClientRequests(text, "src/api.ts");
    expect(calls.map((call) => [call.variants, call.method])).toEqual([
      [["/api/roster"], "GET"],
      [["/api/polls/:*/close"], "POST"],
      [["/api/state", "/api/rooms/:roomId/state"], "GET"],
      [["/api/control/login"], "POST"],
      [["/api/control/bootstrap"], "POST"],
    ]);
    expect(problems).toEqual([]);
  });

  it("flags request arguments that are not statically resolvable", () => {
    const { calls, problems } = extractClientRequests("request(buildPath(), { method: 'GET' });", "src/api.ts");
    expect(calls).toEqual([]);
    expect(problems[0]?.message).toContain("request must be called");
  });
});

describe("browser boundary", () => {
  it("flags raw /api literals outside the shared client module", () => {
    const problems = extractBoundaryViolations('fetch("/api/tasks");', "src/components.tsx");
    expect(problems[0]?.message).toContain("shared client boundary");
    expect(extractBoundaryViolations('fetch("/assets/data.json");', "src/components.tsx")).toEqual([]);
  });
});

describe("contract checking", () => {
  it("accepts a consistent registry, observed registrations, and client calls", () => {
    const serverRoutes = observed(FULL_ROUTES);
    const calls: ClientRequestCall[] = [
      { raw: "/api/tasks", variants: ["/api/tasks"], method: "GET", file: "src/api.ts", line: 1 },
      { raw: "roomPath(\"messages\")", variants: ["/api/messages", "/api/rooms/:roomId/messages"], method: "GET", file: "src/api.ts", line: 2 },
    ];
    const report = checkRouteContracts(table(FULL_ROOTS, FULL_ROUTES), serverRoutes, noProblems, calls, noProblems, noProblems);
    expect(report.failures).toEqual([]);
  });

  it("fails when the server registers a route missing from the registry", () => {
    const extra = [...observed(FULL_ROUTES), { method: "POST", path: "/api/tasks/:taskId/reopen", file: "server/example-api.ts", line: 9 }];
    const report = checkRouteContracts(table(FULL_ROOTS, FULL_ROUTES), extra, noProblems, noCalls, noProblems, noProblems);
    expect(report.failures.join("\n")).toContain("unregistered route POST /api/tasks/:taskId/reopen");
  });

  it("fails when a registry row matches no server registration (removed or renamed route)", () => {
    const report = checkRouteContracts(table(FULL_ROOTS, FULL_ROUTES), observed(FULL_ROUTES.slice(0, -1)), noProblems, noCalls, noProblems, noProblems);
    expect(report.failures.join("\n")).toContain("contract GET /api/control/status matches no server registration");
  });

  it("fails when a room-scoped root lacks its /api/rooms/:roomId twin", () => {
    const withoutTwin = FULL_ROUTES.filter((route) => route.path !== "/api/rooms/:roomId/messages");
    const report = checkRouteContracts(table(FULL_ROOTS, withoutTwin), observed(withoutTwin), noProblems, noCalls, noProblems, noProblems);
    expect(report.failures.join("\n")).toContain("room-scoped route GET /api/messages has no /api/rooms/:roomId twin");
  });

  it("fails when a client call matches no registered route, including method mismatches", () => {
    const calls: ClientRequestCall[] = [
      { raw: "/api/withdrawals/:*", variants: ["/api/withdrawals/:*"], method: "GET", file: "src/api.ts", line: 3 },
      { raw: "/api/roster", variants: ["/api/roster"], method: "PUT", file: "src/api.ts", line: 4 },
    ];
    const report = checkRouteContracts(table(FULL_ROOTS, FULL_ROUTES), observed(FULL_ROUTES), noProblems, calls, noProblems, noProblems);
    expect(report.failures.join("\n")).toContain("client call \"/api/withdrawals/:*\" (GET) at src/api.ts:3 matches no registered route");
    expect(report.failures.join("\n")).toContain("client call \"/api/roster\" (PUT) at src/api.ts:4 matches no registered route");
  });

  it("fails on registry shape defects: duplicate roots, unclassified routes, and noteless canonical roots", () => {
    const roots: readonly ApiRootDefinition[] = [
      { root: "tasks", scope: "canonical" },
      { root: "messages", scope: "room" },
      { root: "messages", scope: "global" },
    ];
    const routes: readonly ApiRouteDefinition[] = [...FULL_ROUTES, { method: "GET", path: "/api/unclassified/thing" }];
    const report = checkRouteContracts(table(roots, routes), observed(routes), noProblems, noCalls, noProblems, noProblems);
    const failures = report.failures.join("\n");
    expect(failures).toContain("classified more than once");
    expect(failures).toContain("requires a note");
    expect(failures).toContain("has no api root classification");
  });

  it("propagates extraction problems as failures so scan gaps cannot pass silently", () => {
    const problems: readonly SourceProblem[] = [{ file: "/repo/server/example-api.ts", line: 7, message: "route paths must be static literals" }];
    const report = checkRouteContracts(table(FULL_ROOTS, FULL_ROUTES), observed(FULL_ROUTES), problems, noCalls, noProblems, noProblems);
    expect(report.failures.join("\n")).toContain("server/example-api.ts:7");
  });
});

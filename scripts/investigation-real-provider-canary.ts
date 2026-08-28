import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

interface ManagedProcess { name: string; child: ChildProcess; output: string[] }
interface StepResult { name: string; status: "passed" | "failed"; durationMs: number; detail?: string }

const projectRoot = process.cwd();
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(projectRoot, ".runtime", "investigation-real-canary", runId);
const dataDirectory = path.join(runRoot, "state");
const canaryProject = path.join(runRoot, "project");
const worktrees = path.join(runRoot, "assignment-worktrees");
const reportPath = path.join(runRoot, "report.json");
const marker = `AMFAA-REAL-CANARY-${randomUUID()}`;
const requireAutonomousInitiation = process.env.AMFAA_CANARY_AUTONOMOUS_INITIATION === "true";
const steps: StepResult[] = [];
const processes: ManagedProcess[] = [];
let room: ManagedProcess | undefined;
let executor: ManagedProcess | undefined;
let cookie = "";
let humanId = "";
let roomBase = "";
let executorBase = "";
let providerSessionId = "";
let publicSummary = "";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function freePort() { return new Promise<number>((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close((error) => error ? reject(error) : resolve(port)); }); }); }
async function http<T = any>(base: string, route: string, input: { method?: string; body?: unknown; cookie?: string; expected?: number | number[] } = {}) { const response = await fetch(`${base}${route}`, { method: input.method || "GET", headers: { ...(input.body === undefined ? {} : { "content-type": "application/json" }), ...(input.cookie ? { cookie: input.cookie } : {}) }, body: input.body === undefined ? undefined : JSON.stringify(input.body) }); const text = await response.text(); let body: any; try { body = text ? JSON.parse(text) : null; } catch { body = text; } const expected = Array.isArray(input.expected) ? input.expected : [input.expected ?? 200]; if (!expected.includes(response.status)) throw new Error(`${input.method || "GET"} ${route} returned ${response.status}: ${text}`); return { status: response.status, body: body as T, text }; }
async function eventually<T>(operation: () => Promise<T | undefined | false>, timeoutMs: number) { const deadline = Date.now() + timeoutMs; let latest: T | undefined | false; while (Date.now() < deadline) { latest = await operation(); if (latest) return latest; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`Timed out after ${timeoutMs}ms; latest=${JSON.stringify(latest)}`); }
async function step(name: string, operation: () => Promise<string | void>) { const started = Date.now(); try { const detail = await operation(); steps.push({ name, status: "passed", durationMs: Date.now() - started, ...(detail ? { detail } : {}) }); process.stdout.write(`PASS ${name}${detail ? ` — ${detail}` : ""}\n`); } catch (error) { const detail = error instanceof Error ? error.message : String(error); steps.push({ name, status: "failed", durationMs: Date.now() - started, detail }); process.stdout.write(`FAIL ${name} — ${detail}\n`); throw error; } }
function controlledEnvironment(overrides: NodeJS.ProcessEnv) { const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ALL_MY_FRIENDS_ARE_AGENTS_") && !name.startsWith("AGENTWIRE_") && name !== "DATABASE_URL")); return { ...base, ...overrides }; }
function start(name: string, file: string, environment: NodeJS.ProcessEnv) { const output: string[] = []; const child = spawn(process.execPath, ["--import", "tsx", file], { cwd: projectRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] }); const record = { name, child, output }; processes.push(record); child.stdout?.on("data", (chunk) => { const value = String(chunk); output.push(value); process.stdout.write(`[${name}] ${value}`); }); child.stderr?.on("data", (chunk) => output.push(String(chunk))); return record; }
async function stop(record: ManagedProcess | undefined) { if (!record || record.child.exitCode !== null) return; record.child.kill("SIGTERM"); await Promise.race([new Promise<void>((resolve) => record.child.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]); if (record.child.exitCode === null) { record.child.kill("SIGKILL"); await new Promise<void>((resolve) => record.child.once("exit", () => resolve())); } }
async function run(command: string, args: string[], cwd = projectRoot) { return new Promise<void>((resolve, reject) => { const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`))); }); }
async function snapshot(directory: string) { const entries: Record<string, string> = {}; async function visit(current: string) { for (const name of (await readdir(current)).sort()) { const absolute = path.join(current, name); const relative = path.relative(directory, absolute); const metadata = await stat(absolute); if (metadata.isDirectory()) await visit(absolute); else if (metadata.isFile()) entries[relative] = createHash("sha256").update(await readFile(absolute)).digest("hex"); } } await visit(directory); return entries; }
async function journal() { try { const directory = path.join(dataDirectory, "logs", "authoritative-v1"); const files = (await readdir(directory)).filter((name) => name.startsWith("generation-provider-exchanges.") && name.endsWith(".jsonl")); return (await Promise.all(files.map((name) => readFile(path.join(directory, name), "utf8")))).join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } }
async function dashboard() { return (await http<any>(roomBase, "/api/investigations", { cookie })).body; }

async function main() {
  assert(process.env.AMFAA_CANARY_ALLOW_REAL_PROVIDER === "true", "Set AMFAA_CANARY_ALLOW_REAL_PROVIDER=true to authorize the two bounded provider calls.");
  await mkdir(dataDirectory, { recursive: true }); await mkdir(canaryProject, { recursive: true }); await mkdir(worktrees, { recursive: true });
  await writeFile(path.join(canaryProject, "identity-anomaly.txt"), `Local identity-integrity observation\nExpected identity: codex-sol\nObserved identity: unknown-agent\nStatus: unresolved mismatch\nCorrelation marker: ${marker}\nExpected disposition: corroborated-local-test-data\n`);
  await writeFile(path.join(canaryProject, "README.md"), "Disposable, read-only real-provider investigation canary.\n");
  await run("git", ["init", "--quiet"], canaryProject);
  const pristine = await snapshot(canaryProject);
  const roomPort = await freePort(); const executorPort = await freePort(); roomBase = `http://127.0.0.1:${roomPort}`; executorBase = `http://127.0.0.1:${executorPort}`;
  executor = start("executor", path.join(projectRoot, "scripts", "investigation-canary-executor.ts"), controlledEnvironment({ AMFAA_CANARY_EXECUTOR_PORT: String(executorPort), AMFAA_CANARY_ALLOW_REAL_PROVIDER: "true", ...(process.env.AMFAA_CANARY_REAL_MODEL ? { AMFAA_CANARY_REAL_MODEL: process.env.AMFAA_CANARY_REAL_MODEL } : {}) }));
  await eventually(async () => { try { return (await http<any>(executorBase, "/health")).body.ready ? true : undefined; } catch { if (executor?.child.exitCode !== null) throw new Error(`Executor exited early:\n${executor?.output.join("")}`); } }, 15_000);
  room = start("room", path.join(projectRoot, "server", "index.ts"), controlledEnvironment({ ALL_MY_FRIENDS_ARE_AGENTS_HOST: "127.0.0.1", ALL_MY_FRIENDS_ARE_AGENTS_PORT: String(roomPort), ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "json", ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: dataDirectory, ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH: canaryProject, ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR: worktrees, ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATIONS_ENABLED: "false", ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATION_CONCURRENCY: "1", ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATION_DEFAULT_TOKEN_LIMIT: requireAutonomousInitiation ? "96000" : "6000", ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATION_EXECUTOR_URL: `${executorBase}/v1/investigations`, ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATION_PROGRESS_BASE_URL: roomBase }));
  await eventually(async () => { try { return (await http<any>(roomBase, "/api/ready")).body.ready ? true : undefined; } catch { if (room?.child.exitCode !== null) throw new Error(`Room exited early:\n${room?.output.join("")}`); } }, 15_000);
  const joined = await fetch(`${roomBase}/api/humans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Real Provider Canary" }) });
  const joinedText = await joined.text(); assert(joined.status === 201, `Join returned ${joined.status}: ${joinedText}`); cookie = joined.headers.get("set-cookie")?.split(";")[0] || ""; const joinedBody = JSON.parse(joinedText) as { id?: string }; humanId = joinedBody.id || ""; assert(cookie && humanId, "Join did not issue a human session.");

  await step(requireAutonomousInitiation ? "autonomous agent decision and real isolated investigation" : "explicit policy enable and real isolated investigation", async () => {
    const current = await dashboard(); await http(roomBase, "/api/investigations/policy", { method: "PATCH", cookie, body: { expectedRevision: current.policy.revision, enabled: true } });
    await http(executorBase, "/control/mode", { method: "POST", body: { mode: "real" } });
    let created: any;
    let transcriptCountAfterInitiation = 0;
    if (requireAutonomousInitiation) {
      await http(roomBase, "/api/settings", { method: "PATCH", cookie, body: { topic: "Identity-integrity smoke test: inspect identity-anomaly.txt. If its unresolved mismatch is credible, request a bounded private investigation." } });
      const knownGenerations = new Set((await journal()).map((event: any) => event.generationId));
      await http(roomBase, "/api/actions", { method: "POST", cookie, body: { action: "ask", target: "codex-sol" }, expected: 202 });
      created = await eventually(async () => (await dashboard()).jobs.find((job: any) => job.signal === "AGENT_DECISION"), 240_000);
      await eventually(async () => (await journal()).find((event: any) => event.type === "generation.delivery" && event.agent === "codex-sol" && !knownGenerations.has(event.generationId)), 240_000);
      transcriptCountAfterInitiation = (await http<any>(roomBase, "/api/state")).body.messages.length;
      assert(created.signal === "AGENT_DECISION", "The live room turn did not autonomously initiate the investigation.");
    } else {
      created = (await http<any>(roomBase, "/api/investigations", { method: "POST", cookie, body: { owner: "codex-sol", objective: `Inspect identity-anomaly.txt and report its exact correlation marker ${marker} plus the expected disposition.`, trigger: "Authenticated live canary of isolated read-only provider execution.", evidenceRefs: [{ kind: "project_artifact", ref: "identity-anomaly.txt", label: "Harmless canary artifact" }], budget: { timeMs: 180_000, tokenLimit: 96_000, toolCallLimit: 10, retryLimit: 0 } } })).body;
    }
    const completed = await eventually(async () => { const found = (await dashboard()).jobs.find((job: any) => job.investigationId === created.investigationId); if (found && ["FAILED", "BLOCKED", "CANCELLED"].includes(found.status)) throw new Error(`Investigation ended ${found.status}: ${found.blocker}`); return found?.status === "COMPLETED" ? found : undefined; }, 210_000);
    assert(completed.providerSessionEstablished, "Investigation did not establish an isolated provider session.");
    const inbox = (await http<any[]>(roomBase, "/api/investigations/inbox/codex-sol", { cookie })).body; const entry = inbox.find((item) => item.investigationId === created.investigationId); assert(entry && entry.summary.trim().length > 0 && entry.evidenceRefs.some((ref: any) => ref.kind === "project_artifact" && ref.ref === "identity-anomaly.txt"), "Real provider result did not return a public summary with the inspected artifact evidence reference."); publicSummary = entry.summary;
    const state = (await http<any>(executorBase, "/control/state")).body; const dispatch = state.dispatches.find((item: any) => item.investigationId === created.investigationId); providerSessionId = dispatch?.providerSessionId || ""; assert(providerSessionId, "Executor did not record the real provider session.");
    assert(JSON.stringify(dispatch.capabilities) === JSON.stringify(["READ_PROJECT", "READ_OBSERVABILITY", "RUN_READ_ONLY_TESTS"]), "Executor capabilities were not read-only bounded.");
    assert(["TASK_AUTHORITY", "EDIT", "EXTERNAL_REQUEST", "COMMIT", "PUSH", "MERGE", "DEPLOY", "PUBLISH"].every((capability) => dispatch.excludedCapabilities.includes(capability)), "Executor exclusion list was incomplete.");
    const publicState = (await http<any>(roomBase, "/api/state")).body; if (requireAutonomousInitiation) assert(publicState.messages.length === transcriptCountAfterInitiation, "Investigation completion added a room message outside the initiating foreground turn."); else assert(!publicState.messages.some((message: any) => String(message.text).includes(marker)), "Investigation summary leaked into the room transcript.");
    assert(JSON.stringify(await snapshot(canaryProject)) === JSON.stringify(pristine), "Investigation modified the disposable project.");
    return `${requireAutonomousInitiation ? "signal=AGENT_DECISION; " : ""}session=${providerSessionId.slice(0, 8)}… tokens=${dispatch.tokens} tools=${dispatch.toolCalls}`;
  });

  await step("bounded later-turn reinjection and foreground session separation", async () => {
    const beforeIds = new Set((await journal()).map((event: any) => event.generationId));
    await http(roomBase, "/api/actions", { method: "POST", cookie, body: { action: "ask", target: "codex-sol" }, expected: 202 });
    const delivery = await eventually(async () => (await journal()).find((event: any) => event.type === "generation.delivery" && event.agent === "codex-sol" && !beforeIds.has(event.generationId)), 240_000);
    const events = await journal(); const started = events.find((event: any) => event.type === "generation.started" && event.generationId === delivery.generationId); assert(started, "Foreground generation start was not journaled.");
    assert(String(started.prompt).includes("INVESTIGATION INBOX") && String(started.prompt).includes(publicSummary), "Foreground prompt did not receive the exact bounded public investigation summary.");
    assert(!String(started.prompt).includes(providerSessionId), "Foreground prompt leaked the raw investigation provider session.");
    const roomState = JSON.parse(await readFile(path.join(dataDirectory, "room.json"), "utf8")); const foregroundSessionId = roomState.sessions?.["codex-sol"]?.id; assert(foregroundSessionId && foregroundSessionId !== providerSessionId, "Foreground and investigation provider sessions were not isolated.");
    assert(JSON.stringify(await snapshot(canaryProject)) === JSON.stringify(pristine), "Foreground read-only turn modified the disposable project.");
    return `delivery=${delivery.outcome}; distinct foreground session=${String(foregroundSessionId).slice(0, 8)}…`;
  });

  await step("inbox closure and policy disable", async () => {
    const inbox = (await http<any[]>(roomBase, "/api/investigations/inbox/codex-sol", { cookie })).body; const entry = inbox.find((item) => item.summary === publicSummary); assert(entry, "Canary inbox entry was missing before closure.");
    await http(roomBase, `/api/investigations/inbox/${encodeURIComponent(entry.inboxEntryId)}/acknowledge`, { method: "POST", cookie, body: { close: true } });
    const current = await dashboard(); await http(roomBase, "/api/investigations/policy", { method: "PATCH", cookie, body: { expectedRevision: current.policy.revision, enabled: false } });
    const final = await dashboard(); assert(final.policy.enabled === false, "Investigation policy remained enabled."); assert(final.jobs.find((job: any) => job.investigationId === entry.investigationId)?.status === "ACKNOWLEDGED", "Investigation was not closed after inbox acknowledgement.");
    return "result closed; persisted policy disabled";
  });
}

let failure: unknown;
try { await main(); } catch (error) { failure = error; } finally {
  if (cookie && roomBase) { try { const current = await dashboard(); if (current.policy?.enabled) await http(roomBase, "/api/investigations/policy", { method: "PATCH", cookie, body: { expectedRevision: current.policy.revision, enabled: false } }); } catch { /* Preserve the primary failure. */ } }
  await stop(room); await stop(executor);
  const report = { schemaVersion: 1, runId, runRoot, status: failure ? "failed" : "passed", marker, requireAutonomousInitiation, providerSessionEstablished: Boolean(providerSessionId), completedAt: new Date().toISOString(), steps, processes: processes.map((record) => ({ name: record.name, exitCode: record.child.exitCode, output: record.output.join("").slice(-30_000) })) };
  await mkdir(runRoot, { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`REAL_CANARY_REPORT ${reportPath}\n`);
}
if (failure) { console.error(failure instanceof Error ? failure.stack || failure.message : failure); process.exitCode = 1; }

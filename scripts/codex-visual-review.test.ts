import { describe, expect, it } from "vitest";
import { codexBatchVerdictSchema, codexEnvironment, codexReviewArgs, executeCodex, groupReviewCaptures, parseCodexResult, requireChatGptLogin, reviewPrompt } from "./codex-visual-review.js";
import { VISUAL_QUESTIONS, type VisualRun } from "./visual-review.js";

const captures: VisualRun["captures"] = [{ key: "chromium--phone--roster-populated--top", engine: "chromium", viewId: "ROOM-05", viewport: { width: 390, height: 844 }, screenshotSha256: "a".repeat(64), layoutIssues: [], scrollRegions: [{ name: "Manage Agents / roster-editor", offset: 40, maximum: 300 }] }];
function result() {
  return { reviews: captures.map((capture) => ({ key: capture.key, inspectedImage: true, answers: Object.fromEntries(VISUAL_QUESTIONS.map((question) => [question, { verdict: "pass", observation: `Visible evidence about ${question} in this image.` }])) })) };
}
function events(value: unknown = result()) {
  return [
    { type: "thread.started", thread_id: "018f1010-1234-4000-8000-000000000001" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 200 } },
  ];
}
const jsonl = (value: unknown[]) => value.map((event) => JSON.stringify(event)).join("\n");

describe("local Codex screenshot reviewer", () => {
  it("keeps paired scroll positions together with exact coverage and bounded batches", () => {
    const keys = ["a--top", "b--top", "c--top", "b--bottom", "d--top", "c--bottom", "e--top"];
    const input = keys.map((key) => ({ ...captures[0], key: `chromium--phone--${key}` }));
    const batches = groupReviewCaptures(input);
    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
    expect(batches.flat().map((capture) => capture.key).sort()).toEqual(input.map((capture) => capture.key).sort());
    for (const scenario of ["b", "c"]) {
      expect(batches.filter((batch) => batch.some((capture) => capture.key.includes(`--${scenario}--`)))).toHaveLength(1);
    }
  });
  it("does not mix engines or actual viewports and allows an intact triple", () => {
    const input = [
      ...["top", "middle", "bottom"].map((position) => ({ ...captures[0], key: `chromium--phone--a--${position}` })),
      { ...captures[0], key: "webkit--phone--b--top", engine: "webkit" as const },
      { ...captures[0], key: "chromium--tablet--b--top", viewport: { width: 768, height: 1024 } },
      { ...captures[0], key: "chromium--phone--b--top", viewport: { width: 320, height: 568 } },
    ];
    expect(groupReviewCaptures(input).map((batch) => batch.length)).toEqual([3, 1, 1, 1]);
    expect(groupReviewCaptures([])).toEqual([]);
  });
  it("rejects duplicate keys and oversized scenarios instead of losing context", () => {
    expect(() => groupReviewCaptures([...captures, ...captures])).toThrow("Duplicate");
    expect(() => groupReviewCaptures(["top", "middle", "lower", "bottom"].map((position) => ({ ...captures[0], key: `chromium--phone--a--${position}` })))).toThrow("three-image");
  });
  it("constrains each generated batch to its exact image keys and count", () => {
    const schema = codexBatchVerdictSchema(captures);
    expect(schema.safeParse(result()).success).toBe(true);
    expect(schema.safeParse({ reviews: [] }).success).toBe(false);
    const wrong = result(); wrong.reviews[0].key = "not-attached";
    expect(schema.safeParse(wrong).success).toBe(false);
    expect(() => codexBatchVerdictSchema([])).toThrow();
    expect(() => codexBatchVerdictSchema([...captures, ...captures])).toThrow();
  });
  it("forwards existing account paths without inheriting API credentials or process hooks", () => {
    expect(codexEnvironment({ PATH: "/tools", HOME: "/home/example", CODEX_HOME: "/auth-location", OPENAI_API_KEY: "example-secret", CODEX_API_KEY: "example-secret", OPENAI_BASE_URL: "https://example.invalid", NODE_OPTIONS: "--require=untrusted.cjs", GITHUB_TOKEN: "example-secret" })).toEqual({ PATH: "/tools", HOME: "/home/example", CODEX_HOME: "/auth-location" });
  });
  it.each([{ CI: "true" }, { GITHUB_ACTIONS: "true" }])("refuses account use in CI", (env) => expect(() => codexEnvironment(env)).toThrow("local-only"));
  it("requires confirmed ChatGPT login without printing other auth output", () => {
    expect(() => requireChatGptLogin("Logged in using ChatGPT\n")).not.toThrow();
    expect(() => requireChatGptLogin("Logged in using an API key")).toThrow("ChatGPT sign-in required");
    expect(() => requireChatGptLogin("Not logged in")).toThrow("ChatGPT sign-in required");
  });
  it("uses fresh read-only image-attached sessions with account-only auth and no tools", () => {
    const args = codexReviewArgs("/tmp/schema.json", ["/tmp/one.png", "/tmp/two.png"]);
    expect(args).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "read-only", 'forced_login_method="chatgpt"', 'approval_policy="never"', "project_doc_max_bytes=0"]));
    expect(args.filter((arg) => arg === "--image")).toHaveLength(2);
    expect(args).toContain("shell_tool");
    expect(args).toContain("plugins");
    expect(args).not.toContain("--model");
    expect(codexReviewArgs("schema", ["image"], "explicit-model")).toContain("explicit-model");
    expect(args.at(-1)).toBe("-");
  });
  it("asks for direct image inspection and seven questions without prescribing approval", () => {
    const prompt = reviewPrompt(captures, "Square raised controls.");
    for (const question of VISUAL_QUESTIONS) expect(prompt).toContain(question);
    expect(prompt).toContain("inspectedImage=false");
    expect(prompt).toContain("untrusted data");
    expect(prompt).toContain("Square raised controls.");
    expect(prompt).not.toContain(captures[0].screenshotSha256);
    expect(prompt).toContain("Manage Agents / roster-editor: 40 / 300");
    expect(prompt).toContain("not visual approval or proof of reachability");
  });
  it("parses a completed turn with image-specific verdicts and usage", () => {
    const parsed = parseCodexResult(jsonl(events()), captures);
    expect(parsed.verdict.reviews).toHaveLength(1);
    expect(parsed.usage.output_tokens).toBe(200);
  });
  it("preserves visual failures instead of rewriting them to pass", () => {
    const value = result();
    value.reviews[0].answers.proportion.verdict = "fail";
    expect(parseCodexResult(jsonl(events(value)), captures).verdict.reviews[0].answers.proportion.verdict).toBe("fail");
  });
  it("allows only the exact disabled-host startup advisory and records it", () => {
    const stream = events();
    const warning = { type: "item.completed", item: { type: "error", message: "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`." } };
    stream.splice(1, 0, warning);
    expect(parseCodexResult(jsonl(stream), captures).startupWarnings).toEqual(["code-mode-host-disabled"]);
    expect(() => parseCodexResult(jsonl([...events(), warning]), captures)).toThrow();
    warning.item.message = "Unknown startup failure";
    expect(() => parseCodexResult(jsonl(stream), captures)).toThrow();
  });
  it.each(["missing", "duplicate", "unknown", "unseen", "missing answer", "failed turn", "incomplete", "tool call", "malformed"])("rejects %s evidence", (kind) => {
    const value = result();
    if (kind === "missing") value.reviews = [];
    if (kind === "duplicate") value.reviews.push(value.reviews[0]);
    if (kind === "unknown") value.reviews[0].key = "not-attached";
    if (kind === "unseen") value.reviews[0].inspectedImage = false;
    if (kind === "missing answer") delete value.reviews[0].answers.screenUse;
    const stream = events(value);
    if (kind === "failed turn") stream.push({ type: "turn.failed" });
    if (kind === "incomplete") stream.pop();
    if (kind === "tool call") stream.push({ type: "item.started", item: { type: "command_execution", text: "unexpected" } });
    expect(() => parseCodexResult(kind === "malformed" ? "not json" : jsonl(stream), captures)).toThrow();
  });
});

describe("bounded local process transport (no live Codex calls)", () => {
  it("passes stdin without a shell", async () => {
    const value = await executeCodex(process.execPath, ["-e", 'process.stdin.pipe(process.stdout)'], process.cwd(), {}, "literal $(not a command)", 5000);
    expect(value.stdout).toBe("literal $(not a command)");
  });
  it("does not expose raw stderr on failure", async () => {
    await expect(executeCodex(process.execPath, ["-e", 'process.stderr.write("example-private-output");process.exit(1)'], process.cwd(), {}, "", 5000)).rejects.toThrow("Codex exited unsuccessfully");
  });
  it("fails when the executable is missing", async () => {
    await expect(executeCodex("/nonexistent-visual-review-codex", [], process.cwd(), {}, "", 1000)).rejects.toThrow("could not start");
  });
  it("terminates a timed-out review", async () => {
    await expect(executeCodex(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.cwd(), {}, "", 100)).rejects.toThrow("timed out");
  });
  it("fails closed on cancellation", async () => {
    const controller = new AbortController();
    const task = executeCodex(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.cwd(), {}, "", 5000, controller.signal);
    controller.abort();
    await expect(task).rejects.toThrow("interrupted");
  });
});

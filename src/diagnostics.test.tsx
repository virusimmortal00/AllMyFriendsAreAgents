// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { controlLogin, controlLogout } from "./api";
import { updateControlSession } from "./control-session-state";
import { assembleDiagnosticChunks, Diagnostics, summarizeTraceEvidence } from "./diagnostics";

afterEach(() => { cleanup(); updateControlSession({ status: null, session: null, checked: false, error: "" }); vi.restoreAllMocks(); });

function response(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })); }
const traceId = "a".repeat(32);
const record = { recordId: "diag-1", stream: "generations", timestamp: "2026-08-28T12:00:00.000Z", severity: "info", event: "generation.completed", generationId: "generation-one", correlationId: "correlation-one", traceId, content: { prompt: "peer prompt", rawOutput: "provider output" } };
const page = (overrides: Record<string, unknown> = {}) => ({ records: [record], chunks: [], nextCursor: null, scannedBytes: 1024, serializedBytes: 512, malformedRecords: 0, scanLimitReached: false, ...overrides });

describe("owner diagnostic dashboard", () => {
  it.each([null, "ADMIN", "MEMBER"] as const)("disables owner actions for a known %s session and restores them after owner sign-in", async (role) => {
    const principal = { id: "account", username: "account", role: role ?? "MEMBER", capabilities: [], revision: 1 };
    const expiresAt = new Date(Date.now() + 28_800_000).toISOString();
    updateControlSession({ checked: true, session: role ? { principal, expiresAt } : null });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response(page()));
    const onOpenAdministration = vi.fn();
    render(<Diagnostics onOpenAdministration={onOpenAdministration} />);
    for (const name of ["Query diagnostics", "Refresh capability diagnostics"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect((screen.getByLabelText("Correlation ID") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Sign in with an OWNER account");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to server administration" }));
    expect(onOpenAdministration).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => { updateControlSession({ session: { principal: { ...principal, role: "OWNER" }, expiresAt } }); });
    expect((screen.getByRole("button", { name: "Query diagnostics" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Refresh capability diagnostics" }) as HTMLButtonElement).disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await screen.findByRole("button", { name: /generation.completed/ });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("clears owner records on logout and ignores a late diagnostic response", async () => {
    const session = { principal: { id: "owner", username: "owner", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "fictional-csrf", expiresAt: new Date(Date.now() + 28_800_000).toISOString() };
    let finishQuery!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).endsWith("/login")) return response(session);
      if (String(input).endsWith("/logout")) return Promise.resolve(new Response(null, { status: 204 }));
      return response(page());
    });
    await controlLogin("owner", "fictional-password");
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    const recordButton = await screen.findByRole("button", { name: /generation.completed/ });
    fireEvent.click(recordButton);
    expect(screen.getByText(/peer prompt/)).toBeTruthy();
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishQuery = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await act(async () => { await controlLogout(); });
    await act(async () => { finishQuery(await response(page())); });
    expect(screen.queryByRole("button", { name: /generation.completed/ })).toBeNull();
    expect(screen.queryByText(/peer prompt/)).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in to server administration" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Query diagnostics" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Refresh capability diagnostics" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("starts empty and uses the owner session rather than a diagnostic bearer token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response(page()));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/token/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await screen.findByRole("button", { name: /generation.completed/ });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/control/diagnostics/query");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).has("Authorization")).toBe(false);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ scope: "operator", limit: 50, maxScannedBytes: 1_048_576, maxSerializedBytes: 262_144 });
  });

  it("clears loaded owner data when a session refresh discovers a different account", async () => {
    const principal = { id: "owner", username: "owner", role: "OWNER" as const, capabilities: [], revision: 1 };
    const expiresAt = new Date(Date.now() + 28_800_000).toISOString();
    updateControlSession({ checked: true, session: { principal, expiresAt } });
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(page()));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    fireEvent.click(await screen.findByRole("button", { name: /generation.completed/ }));
    expect(screen.getByText(/peer prompt/)).toBeTruthy();
    act(() => { updateControlSession({ session: { principal: { ...principal, id: "member", role: "MEMBER" }, expiresAt } }); });
    expect(screen.queryByRole("button", { name: /generation.completed/ })).toBeNull();
    expect(screen.queryByText(/peer prompt/)).toBeNull();
    expect((screen.getByRole("button", { name: "Query diagnostics" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("ignores a late denial from the previous session while a new owner query is pending", async () => {
    const principal = { id: "owner", username: "owner", role: "OWNER" as const, capabilities: [], revision: 1 };
    const expiresAt = new Date(Date.now() + 28_800_000).toISOString();
    updateControlSession({ checked: true, session: { principal, expiresAt } });
    let finishOld!: (response: Response) => void;
    let finishNew!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishNew = resolve; }));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    act(() => { updateControlSession({ session: null }); });
    act(() => { updateControlSession({ session: { principal, expiresAt } }); });
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await act(async () => { finishOld(await response({ error: "Sign in required" }, 401)); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Loading…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finishNew(await response(page())); });
    await screen.findByRole("button", { name: /generation.completed/ });
    expect((screen.getByRole("button", { name: "Query diagnostics" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears previously loaded records when capability inspection denies access", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response(page()))
      .mockImplementationOnce(() => response({ error: "Owner required" }, 403));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    fireEvent.click(await screen.findByRole("button", { name: /generation.completed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh capability diagnostics" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /generation.completed/ })).toBeNull();
    expect(screen.queryByText(/peer prompt/)).toBeNull();
  });

  it("recovers CSRF state from an existing owner session before retrying the query", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response({ error: "Diagnostics are unavailable." }, 403))
      .mockImplementationOnce(() => response({ principal: { id: "owner-1", username: "owner", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "owner-csrf" }))
      .mockImplementationOnce(() => response(page()));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await screen.findByRole("button", { name: /generation.completed/ });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/control/me");
    expect(new Headers((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).get("X-AMFAA-CSRF")).toBe("owner-csrf");
  });

  it("keeps the original bounded filter context while paginating", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response(page({ nextCursor: "cursor-one" })))
      .mockImplementationOnce(() => response(page({ records: [{ ...record, recordId: "diag-2", event: "generation.failed" }] })));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Diagnostic visibility"), { target: { value: "project" } });
    fireEvent.change(screen.getByLabelText("Diagnostic stream"), { target: { value: "generations" } });
    fireEvent.change(screen.getByLabelText("Correlation ID"), { target: { value: "correlation-one" } });
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await screen.findByRole("button", { name: "Load next bounded page" });
    fireEvent.change(screen.getByLabelText("Diagnostic visibility"), { target: { value: "self" } });
    fireEvent.change(screen.getByLabelText("Correlation ID"), { target: { value: "changed-after-first-page" } });
    fireEvent.click(screen.getByRole("button", { name: "Load next bounded page" }));
    await screen.findByRole("button", { name: /generation.failed/ });
    const first = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const second = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(second).toMatchObject({ scope: "project", streams: ["generations"], correlation: { correlationId: "correlation-one" }, cursor: "cursor-one" });
    expect(second.from).toBe(first.from); expect(second.to).toBe(first.to);
    expect(screen.getByRole("button", { name: /generation.completed/ })).toBeTruthy();
  });

  it("keeps correlation and trace selectors explicit and exact", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response(page()));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Correlation ID"), { target: { value: "correlation-one" } });
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await screen.findByRole("button", { name: /generation.completed/ });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).correlation).toEqual({ correlationId: "correlation-one" });

    fireEvent.change(screen.getByLabelText("Diagnostic selector"), { target: { value: "traceId" } });
    fireEvent.change(screen.getByLabelText("Trace ID"), { target: { value: traceId } });
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const traceQuery = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(traceQuery.correlation).toEqual({ traceId });
    expect(traceQuery.streams).toHaveLength(6);
    expect(traceQuery.correlation).not.toHaveProperty("correlationId");
  });

  it("requires a non-empty trace ID before querying a whole trace", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response(page()));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Diagnostic selector"), { target: { value: "traceId" } });
    const query = screen.getByRole("button", { name: "Query diagnostics" }) as HTMLButtonElement;
    expect(query.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Trace ID"), { target: { value: "   " } });
    expect(query.disabled).toBe(true);
    fireEvent.click(query);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the whole-trace selector and bounded window across pages", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response(page({ nextCursor: "trace-cursor" })))
      .mockImplementationOnce(() => response(page({ records: [{ ...record, recordId: "diag-2" }] })));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Diagnostic selector"), { target: { value: "traceId" } });
    fireEvent.change(screen.getByLabelText("Trace ID"), { target: { value: traceId } });
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await screen.findByRole("button", { name: "Load next bounded page" });
    fireEvent.change(screen.getByLabelText("Diagnostic selector"), { target: { value: "correlationId" } });
    fireEvent.change(screen.getByLabelText("Correlation ID"), { target: { value: "do-not-substitute" } });
    fireEvent.click(screen.getByRole("button", { name: "Load next bounded page" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const first = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const second = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(second).toMatchObject({ correlation: { traceId }, cursor: "trace-cursor" });
    expect(second.from).toBe(first.from);
    expect(second.to).toBe(first.to);
  });

  it.each([
    ["structured decision", { ...record, recordId: "decision", event: "conversation.turn.finished", correlationId: "run-one", content: { runId: "run-one", runEventSequence: 2, generationId: "generation-one" } }],
    ["raw evidence", record],
  ])("opens the whole trace from %s without broadening the prior query", async (_description, selectedRecord) => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response(page({ records: [selectedRecord] })))
      .mockImplementationOnce(() => response(page({ records: [selectedRecord] })));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Correlation ID"), { target: { value: "correlation-one" } });
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(selectedRecord.event) }));
    fireEvent.click(screen.getByRole("button", { name: "Open whole trace" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const query = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(query).toMatchObject({ scope: "operator", correlation: { traceId } });
    expect(query.streams).toHaveLength(6);
    expect(query.correlation).not.toHaveProperty("correlationId");
    expect((screen.getByLabelText("Diagnostic selector") as HTMLSelectElement).value).toBe("traceId");
    expect((screen.getByLabelText("Trace ID") as HTMLInputElement).value).toBe(traceId);
  });

  it("preserves loaded records when a later bounded page fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response(page({ nextCursor: "cursor-one" })))
      .mockImplementationOnce(() => response({ error: "unavailable" }, 500));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await screen.findByRole("button", { name: /generation.completed/ });
    fireEvent.click(screen.getByRole("button", { name: "Load next bounded page" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: /generation.completed/ })).toBeTruthy();
  });

  it("renders preserved evidence only after selection and redacts authentication secrets", async () => {
    const sensitive = { ...record, content: { prompt: "peer prompt", rawOutput: "provider output", stdout: "OpenCode stdout", stderr: "OpenCode stderr", toolOutcome: "completed", providerError: "bounded failure", usage: 21, cost: 0.04, routing: "provider/model", rateLimit: "clear", cooldown: "none", authorization: "Bearer bearer-secret", password: "unsafe" } };
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(page({ records: [sensitive] })));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    fireEvent.click(await screen.findByRole("button", { name: /generation.completed/ }));
    await waitFor(() => expect(document.body.textContent).toContain("provider output"));
    expect(document.body.textContent).toContain("OpenCode stdout");
    expect(document.body.textContent).toContain("toolOutcome");
    expect(document.body.textContent).toContain("[REDACTED]");
    expect(document.body.textContent).not.toContain("bearer-secret");
    expect(document.body.textContent).not.toContain("unsafe");
    expect(document.body.textContent).toContain("not a claim of hidden chain-of-thought");
  });

  it("fails closed without echoing an authorization response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ error: "cookie secret-value" }, 401));
    const { container } = render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Diagnostics are unavailable");
    expect(container.textContent).not.toContain("secret-value");
    expect((screen.getByRole("button", { name: "Query diagnostics" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Refresh capability diagnostics" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the selected result state associated with its adjacent detail", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(page({ records: [record, { ...record, recordId: "diag-2", event: "generation.failed", content: { outcome: "failed" } }] })));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    const completed = await screen.findByRole("button", { name: /generation.completed/ });
    const failed = screen.getByRole("button", { name: /generation.failed/ });
    expect(completed.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(completed);
    expect(completed.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { name: "generation.completed" })).toBeTruthy();
    fireEvent.click(failed);
    expect(completed.getAttribute("aria-pressed")).toBe("false");
    expect(failed.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("heading", { name: "generation.completed" })).toBeNull();
    expect(screen.getByRole("heading", { name: "generation.failed" })).toBeTruthy();
  });

  it("reassembles a large diagnostic record from bounded chunks", () => {
    const bytes = Buffer.from(JSON.stringify(record)); const split = Math.floor(bytes.length / 2);
    expect(assembleDiagnosticChunks([
      { kind: "record-chunk", recordId: record.recordId, stream: record.stream, offset: 0, totalBytes: bytes.length, encoding: "base64-json-utf8", data: bytes.subarray(0, split).toString("base64"), final: false },
      { kind: "record-chunk", recordId: record.recordId, stream: record.stream, offset: split, totalBytes: bytes.length, encoding: "base64-json-utf8", data: bytes.subarray(split).toString("base64"), final: true },
    ])).toEqual([record]);
  });

  it("skips a chunk with malformed base64 without interrupting rendering", () => {
    expect(assembleDiagnosticChunks([
      { kind: "record-chunk", recordId: record.recordId, stream: record.stream, offset: 0, totalBytes: 3, encoding: "base64-json-utf8", data: "%%%", final: true },
    ])).toEqual([]);
  });

  it("reports complete reconstruction only after all pages and linked evidence are present", () => {
    const structured = [
      { ...record, recordId: "run-start", event: "conversation.run.started", correlationId: "run-one", generationId: undefined, content: { runId: "run-one", runEventSequence: 1 } },
      { ...record, recordId: "turn-finished", event: "conversation.turn.finished", correlationId: "run-one", content: { runId: "run-one", runEventSequence: 2, generationId: "generation-one" } },
      { ...record, recordId: "run-complete", event: "conversation.run.completed", correlationId: "run-one", generationId: undefined, content: { runId: "run-one", runEventSequence: 3, attemptedEventCount: 3 } },
    ];
    const jobRecords = [
      { ...record, recordId: "job-decision", event: "conversation.job.decision", correlationId: "request-one", generationId: undefined, content: { jobId: "job-one", action: "queued" } },
      { ...record, recordId: "job-consumed", event: "conversation.job.consumed", correlationId: "request-one", generationId: undefined, content: { jobId: "job-one" } },
    ];
    expect(summarizeTraceEvidence([...jobRecords, ...structured, record], true)).toMatchObject({ status: "partial" });
    expect(summarizeTraceEvidence([...jobRecords, ...structured, record], false)).toMatchObject({ status: "complete", runCount: 1, unpairedRecordIds: [], missingRawGenerationIds: [] });
  });

  it("keeps unpaired raw evidence visible and describes absent evidence without guessing a cause", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(page({ records: [{ ...record, generationId: "orphan-generation" }] })));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Diagnostic selector"), { target: { value: "traceId" } });
    fireEvent.change(screen.getByLabelText("Trace ID"), { target: { value: traceId } });
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    expect(await screen.findByRole("button", { name: /generation.completed.*Unpaired/ })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Trace evidence is incomplete");
    expect(document.body.textContent).toContain("The cause is unknown");
    expect(document.body.textContent).toContain("retention, transport loss, legacy schema, or unfinished work");
  });

  it("detects sequence gaps and decision records whose raw evidence is absent", () => {
    const records = [
      { ...record, recordId: "run-start", event: "conversation.run.started", correlationId: "run-one", generationId: undefined, content: { runId: "run-one", runEventSequence: 1 } },
      { ...record, recordId: "turn-finished", event: "conversation.turn.finished", correlationId: "run-one", generationId: "generation-missing", content: { runId: "run-one", runEventSequence: 3, generationId: "generation-missing" } },
      { ...record, recordId: "run-complete", event: "conversation.run.completed", correlationId: "run-one", generationId: undefined, content: { runId: "run-one", runEventSequence: 4, attemptedEventCount: 4 } },
    ];
    expect(summarizeTraceEvidence(records, false)).toMatchObject({ status: "incomplete", missingSequences: [2], missingRawGenerationIds: ["generation-missing"] });
  });

  it("preserves the explicit owner capability inspector", async () => {
    const projection = { policyRevision: 1, agents: { "codex-sol": { agentId: "codex-sol", capabilities: { conversation: { effective: true } }, effectiveCommands: ["gh"] } }, audit: [{ id: "audit-1", timestamp: "2026-08-28T12:00:00.000Z", agentId: "codex-sol", capability: "github_read", outcome: "completed" }] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response(projection));
    render(<Diagnostics onOpenAdministration={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh capability diagnostics" }));
    expect(await screen.findByText(/Policy revision 1/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Capability audit events" }).textContent).toContain("github_read · completed");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/control/capabilities?limit=100");
  });

});

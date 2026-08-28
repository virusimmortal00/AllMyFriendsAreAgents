// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { assembleDiagnosticChunks, Diagnostics } from "./diagnostics";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function response(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })); }
const record = { recordId: "diag-1", stream: "generations", timestamp: "2026-08-28T12:00:00.000Z", severity: "info", event: "generation.completed", correlationId: "correlation-one", content: { prompt: "peer prompt", rawOutput: "provider output" } };
const page = (overrides: Record<string, unknown> = {}) => ({ records: [record], chunks: [], nextCursor: null, scannedBytes: 1024, serializedBytes: 512, malformedRecords: 0, scanLimitReached: false, ...overrides });

describe("owner diagnostic dashboard", () => {
  it("starts empty and uses the owner session rather than a diagnostic bearer token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response(page()));
    render(<Diagnostics />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/token/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await screen.findByRole("button", { name: /generation.completed/ });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/control/diagnostics/query");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).has("Authorization")).toBe(false);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ scope: "operator", limit: 50, maxScannedBytes: 1_048_576, maxSerializedBytes: 262_144 });
  });

  it("recovers CSRF state from an existing owner session before retrying the query", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response({ error: "Diagnostics are unavailable." }, 403))
      .mockImplementationOnce(() => response({ principal: { id: "owner-1", username: "owner", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "owner-csrf" }))
      .mockImplementationOnce(() => response(page()));
    render(<Diagnostics />);
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await screen.findByRole("button", { name: /generation.completed/ });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/control/me");
    expect(new Headers((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).get("X-AMFAA-CSRF")).toBe("owner-csrf");
  });

  it("keeps the original bounded filter context while paginating", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response(page({ nextCursor: "cursor-one" })))
      .mockImplementationOnce(() => response(page({ records: [{ ...record, recordId: "diag-2", event: "generation.failed" }] })));
    render(<Diagnostics />);
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

  it("renders preserved evidence only after selection and redacts authentication secrets", async () => {
    const sensitive = { ...record, content: { prompt: "peer prompt", rawOutput: "provider output", stdout: "OpenCode stdout", stderr: "OpenCode stderr", toolOutcome: "completed", providerError: "bounded failure", usage: 21, cost: 0.04, routing: "provider/model", rateLimit: "clear", cooldown: "none", authorization: "Bearer bearer-secret", password: "unsafe" } };
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response(page({ records: [sensitive] })));
    render(<Diagnostics />);
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
    const { container } = render(<Diagnostics />);
    fireEvent.click(screen.getByRole("button", { name: "Query diagnostics" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Diagnostics are unavailable");
    expect(container.textContent).not.toContain("secret-value");
  });

  it("reassembles a large diagnostic record from bounded chunks", () => {
    const bytes = Buffer.from(JSON.stringify(record)); const split = Math.floor(bytes.length / 2);
    expect(assembleDiagnosticChunks([
      { kind: "record-chunk", recordId: record.recordId, stream: record.stream, offset: 0, totalBytes: bytes.length, encoding: "base64-json-utf8", data: bytes.subarray(0, split).toString("base64"), final: false },
      { kind: "record-chunk", recordId: record.recordId, stream: record.stream, offset: split, totalBytes: bytes.length, encoding: "base64-json-utf8", data: bytes.subarray(split).toString("base64"), final: true },
    ])).toEqual([record]);
  });

  it("preserves the explicit owner capability inspector", async () => {
    const projection = { policyRevision: 1, agents: { "codex-sol": { agentId: "codex-sol", capabilities: { conversation: { effective: true } }, effectiveCommands: ["gh"] } }, audit: [{ id: "audit-1", timestamp: "2026-08-28T12:00:00.000Z", agentId: "codex-sol", capability: "github_read", outcome: "completed" }] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response(projection));
    render(<Diagnostics />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh capability diagnostics" }));
    expect(await screen.findByText(/Policy revision 1/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Capability audit events" }).textContent).toContain("github_read · completed");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/control/capabilities?limit=100");
  });
});

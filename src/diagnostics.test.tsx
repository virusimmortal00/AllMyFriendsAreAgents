// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Diagnostics } from "./diagnostics";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function response(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status })); }
const record = { recordId: "diag-1", agentId: "codex-sol", attemptId: "attempt-1", generationId: null, promptFingerprint: "sha256:bounded", reason: "stalled", metadata: { stage: 2 }, diagnosticText: "bounded diagnostic", createdAt: "2026-08-27T12:00:00.000Z" };

describe("authorized diagnostic dashboard", () => {
  it("renders the owner-only effective capability and audit inspector on explicit refresh", async () => {
    const projection = { policyRevision: 1, agents: { "codex-sol": { agentId: "codex-sol", policyRevision: 1, capabilities: { conversation: { configured: true, runtimeAvailable: true, effective: true, reason: "available", guidance: "safe" }, github_read: { configured: true, runtimeAvailable: true, effective: true, reason: "available", guidance: "safe", contract: "read-only" }, project_write: { configured: false, runtimeAvailable: false, effective: false, reason: "governed_worker_only", guidance: "worker" } }, effectiveCommands: ["gh"], commands: { gh: { featureCompiled: true, requiredConfigPresent: true, serverCeiling: true, rosterEnabled: true, requestedGrant: true, catalogRevisionCurrent: true, providerSessionFresh: true, lease: { status: "active", issuedAt: "2026-08-27T11:00:00.000Z", expiresAt: "2026-08-27T12:00:00.000Z" }, lastManifestIssuance: { revision: 2, issuedAt: "2026-08-27T11:00:00.000Z" }, lastRejection: null, effective: true, exclusions: [] } } } }, audit: [{ id: "audit-1", timestamp: "2026-08-27T12:00:00.000Z", agentId: "codex-sol", capability: "github_read", outcome: "completed", reason: "available" }] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response(projection));
    render(<Diagnostics agents={["codex-sol"]} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh capability diagnostics" }));
    expect(await screen.findByText(/Policy revision 1/)).toBeTruthy();
    expect(screen.getByText(/github_read: effective · read-only/)).toBeTruthy();
    expect(screen.getByText(/compiled true · config true · ceiling true/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Capability audit events" }).textContent).toContain("github_read · completed");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/control/capabilities?limit=100");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).has("Authorization")).toBe(false);
  });

  it("does not request diagnostics until a user explicitly searches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ items: [record] }));
    render(<Diagnostics agents={["codex-sol"]} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Diagnostic-read token"), { target: { value: "read-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Search / Refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/developer/diagnostics?agentId=codex-sol&limit=50");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("Authorization")).toBe("Bearer read-token");
  });

  it("keeps authorization failures out of the transcript and does not echo the token", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => response({ error: "token bearer-secret must not render" }, 404));
    const { container } = render(<Diagnostics agents={["codex-sol"]} />);
    fireEvent.change(screen.getByLabelText("Diagnostic-read token"), { target: { value: "bearer-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Search / Refresh" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Diagnostics are unavailable");
    expect(container.textContent).not.toContain("bearer-secret");
    expect(container.textContent).not.toContain("token bearer-secret");
  });

  it("loads bounded detail only after the user selects a list item", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => String(input).includes("diag-1") ? response(record) : response({ items: [record] }));
    render(<Diagnostics agents={["codex-sol"]} />);
    fireEvent.change(screen.getByLabelText("Diagnostic-read token"), { target: { value: "read-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Search / Refresh" }));
    await screen.findByRole("button", { name: /stalled/ });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /stalled/ }));
    expect(await screen.findByText("bounded diagnostic")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("redacts a secret-shaped detail value before rendering it", async () => {
    const sensitive = { ...record, diagnosticText: '{"password":"json-secret","authorization":"Bearer bearer-secret"}\nAPI_KEY=env-secret\nBasic dXNlcjpwYXNz', metadata: { password: "password=unsafe" } };
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => String(input).includes("diag-1") ? response(sensitive) : response({ items: [sensitive] }));
    render(<Diagnostics agents={["codex-sol"]} />);
    fireEvent.change(screen.getByLabelText("Diagnostic-read token"), { target: { value: "read-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Search / Refresh" }));
    await screen.findByRole("button", { name: /stalled/ });
    fireEvent.click(screen.getByRole("button", { name: /stalled/ }));
    await waitFor(() => expect(document.body.textContent).toContain("[REDACTED]"));
    expect(document.body.textContent).not.toContain("bearer-secret");
    expect(document.body.textContent).not.toContain("unsafe");
    expect(document.body.textContent).not.toContain("json-secret");
    expect(document.body.textContent).not.toContain("env-secret");
    expect(document.body.textContent).not.toContain("dXNlcjpwYXNz");
  });
});

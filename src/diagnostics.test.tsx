// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Diagnostics } from "./diagnostics";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function response(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status })); }
const record = { recordId: "diag-1", agentId: "codex-sol", attemptId: "attempt-1", generationId: null, promptFingerprint: "sha256:bounded", reason: "stalled", metadata: { stage: 2 }, diagnosticText: "bounded diagnostic", createdAt: "2026-08-27T12:00:00.000Z" };

describe("authorized diagnostic dashboard", () => {
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
    const sensitive = { ...record, diagnosticText: "authorization: bearer-secret", metadata: { password: "password=unsafe" } };
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => String(input).includes("diag-1") ? response(sensitive) : response({ items: [sensitive] }));
    render(<Diagnostics agents={["codex-sol"]} />);
    fireEvent.change(screen.getByLabelText("Diagnostic-read token"), { target: { value: "read-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Search / Refresh" }));
    await screen.findByRole("button", { name: /stalled/ });
    fireEvent.click(screen.getByRole("button", { name: /stalled/ }));
    await waitFor(() => expect(screen.getAllByText("[REDACTED]")).toHaveLength(2));
    expect(document.body.textContent).not.toContain("bearer-secret");
    expect(document.body.textContent).not.toContain("unsafe");
  });
});

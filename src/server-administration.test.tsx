// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerAdministration } from "./server-administration";
import { HumanProfileDialog } from "./human-avatar";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { refreshControlSession } from "./control-session";
import { controlSessionSnapshot, updateControlSession } from "./control-session-state";
import { controlLogin, controlLogout, loadControlMe, loadRoster, updateRoster } from "./api";

const principal = { id: "durable-owner", username: "server-owner", role: "OWNER", capabilities: [], revision: 1 } as const;
function fixture(options: { claimed?: boolean; signedIn?: boolean; bootstrapConfigured?: boolean; role?: "OWNER" | "ADMIN"; expiresAt?: string } = {}) {
  let claimed = options.claimed ?? true;
  let signedIn = options.signedIn ?? false;
  const session = { principal: { ...principal, role: options.role ?? "OWNER" }, csrfToken: "fictional-control-csrf", expiresAt: options.expiresAt ?? new Date(Date.now() + 28_800_000).toISOString() };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/control/status") return Response.json({ claimed, bootstrapConfigured: options.bootstrapConfigured ?? true });
    if (path === "/api/control/me") return signedIn ? Response.json(session) : Response.json({ error: "Sign in required" }, { status: 401 });
    if (path === "/api/control/login" || path === "/api/control/bootstrap") { claimed = true; signedIn = true; return Response.json(session); }
    if (path === "/api/control/logout") { signedIn = false; return new Response(null, { status: 204 }); }
    if (path === "/api/roster") return Response.json({ access: { kind: "room-member", csrfToken: "fictional-member-csrf" }, roster: { revision: 1, entries: [] }, catalog: [] });
    throw new Error(`Unexpected request: ${init?.method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, session, restart: () => { signedIn = false; } };
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), clear: () => values.clear() });
});

afterEach(async () => {
  cleanup();
  await act(async () => { await Promise.resolve(); });
  updateControlSession({ status: null, session: null, checked: false, error: "" });
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("canonical server administration", () => {
  it.each([true, false])("authenticates claimed=%s with Enter and returns to the requested destination", async (claimed) => {
    const { fetchMock } = fixture({ claimed });
    const onContinue = vi.fn();
    render(<ServerAdministration destination="Diagnostics" onContinue={onContinue} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "server-owner");
    if (!claimed) await user.type(screen.getByLabelText("Local bootstrap secret"), "fictional-bootstrap-proof");
    else expect(screen.queryByLabelText("Local bootstrap secret")).toBeNull();
    await user.type(screen.getByLabelText("Password"), "fictional-password{enter}");
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith("Diagnostics"));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith(claimed ? "/login" : "/bootstrap"))).toHaveLength(1);
    expect(screen.getByText("server-owner")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("requires configured local bootstrap proof and never exposes an unclaim action", async () => {
    fixture({ claimed: false, bootstrapConfigured: false });
    render(<ServerAdministration destination={null} onContinue={vi.fn()} />);
    expect((await screen.findByRole("button", { name: "Claim owner" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Local bootstrap secret") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /unclaim/i })).toBeNull();
  });

  it("retains room identity and membership CSRF when signing out and shows the server expiry", async () => {
    const { fetchMock, session } = fixture({ signedIn: true });
    const profileKey = "all-my-friends-are-agents-human";
    localStorage.setItem(profileKey, JSON.stringify({ id: "room-member", name: "A room name" }));
    const storage = localStorage.getItem(profileKey);
    await loadRoster();
    render(<ServerAdministration destination={null} onContinue={vi.fn()} />);
    const signOut = await screen.findByRole("button", { name: "Sign out" });
    expect(document.querySelector("time")?.dateTime).toBe(session.expiresAt);
    await userEvent.setup().click(signOut);
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByRole("button", { name: "Claim owner" })).toBeNull();
    expect(controlSessionSnapshot().session).toBeNull();
    expect(localStorage.getItem(profileKey)).toBe(storage);
    await updateRoster(1, []);
    const logout = fetchMock.mock.calls.find(([url]) => url === "/api/control/logout");
    expect(new Headers(logout?.[1]?.headers).get("X-AMFAA-CSRF")).toBe("fictional-control-csrf");
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get("X-AMFAA-CSRF")).toBe("fictional-member-csrf");
    expect(fetchMock.mock.calls.some(([url]) => /humans|leave/.test(String(url)))).toBe(false);
  });

  it("separates mutable room names from the durable principal in the profile", async () => {
    fixture({ signedIn: true });
    const onOpenAdministration = vi.fn();
    render(<HumanProfileDialog human={{ id: "room-member", name: "Room Alias", style: DEFAULT_PARTICIPANT_STYLES.you }} busy={false} returnFocusTo={null} onClose={vi.fn()} onProfileChange={vi.fn()} onOpenAdministration={onOpenAdministration} />);
    expect(await screen.findByText("server-owner")).toBeTruthy();
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Display name"));
    await user.type(screen.getByLabelText("Display name"), "New Alias");
    expect(screen.getByText("server-owner")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open server administration" }));
    expect(onOpenAdministration).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("keeps non-owner sessions distinct from owner-only Diagnostics access", async () => {
    fixture({ role: "ADMIN" });
    const onContinue = vi.fn();
    render(<ServerAdministration destination="Diagnostics" onContinue={onContinue} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "server-owner");
    await user.type(screen.getByLabelText("Password"), "fictional-password{enter}");
    expect(await screen.findByText(/Diagnostics requires the OWNER role/)).toBeTruthy();
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Continue to Diagnostics" })).toBeNull();
  });

  it("recovers after restart without offering to reclaim ownership", async () => {
    const { restart } = fixture({ signedIn: true });
    render(<ServerAdministration destination={null} onContinue={vi.fn()} />);
    await screen.findByRole("button", { name: "Sign out" });
    restart();
    await act(async () => { await refreshControlSession(); });
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByRole("button", { name: "Claim owner" })).toBeNull();
    await act(async () => { await controlLogin("server-owner", "fictional-password"); });
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("expires at the server-projected time even while the view remains open", async () => {
    vi.useFakeTimers();
    const { restart } = fixture({ signedIn: true, expiresAt: new Date(Date.now() + 1_000).toISOString() });
    render(<ServerAdministration destination={null} onContinue={vi.fn()} />);
    await act(async () => { await refreshControlSession(); });
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    restart();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("bounds expiry rechecks when the browser clock is ahead of the server", async () => {
    vi.useFakeTimers();
    const { fetchMock } = fixture({ signedIn: true, expiresAt: new Date(Date.now() - 1_000).toISOString() });
    render(<ServerAdministration destination={null} onContinue={vi.fn()} />);
    await act(async () => { await refreshControlSession(); });
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    const initialRequests = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(fetchMock).toHaveBeenCalledTimes(initialRequests);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(initialRequests + 2);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("does not let background checks supersede an in-flight sign-in", async () => {
    const { session } = fixture();
    let finishLogin!: (response: Response) => void;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith("/login")) return new Promise<Response>((resolve) => { finishLogin = resolve; });
      if (String(input).endsWith("/status")) return Promise.resolve(Response.json({ claimed: true, bootstrapConfigured: false }));
      return Promise.resolve(Response.json({ error: "Not signed in yet" }, { status: 401 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const signingIn = controlLogin("server-owner", "fictional-password");
    await refreshControlSession();
    await expect(loadControlMe()).rejects.toMatchObject({ status: 401 });
    finishLogin(Response.json(session));
    await signingIn;
    expect(controlSessionSnapshot().session?.principal.username).toBe("server-owner");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/status"))).toBe(false);
  });

  it("reports an unconfirmed logout and reloads server authority before retry", async () => {
    const { fetchMock } = fixture({ signedIn: true });
    const original = fetchMock.getMockImplementation()!;
    let failLogout = true;
    fetchMock.mockImplementation((input, init) => {
      if (String(input).endsWith("/logout") && failLogout) { failLogout = false; return Promise.resolve(Response.json({ error: "Unavailable" }, { status: 503 })); }
      return original(input, init);
    });
    render(<ServerAdministration destination={null} onContinue={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByText(/Sign-out could not be confirmed/);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears a roster CSRF token derived from the administrator session", async () => {
    fixture({ signedIn: true });
    await controlLogin("server-owner", "fictional-password");
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => String(input).endsWith("/logout") ? new Response(null, { status: 204 }) : Response.json({ access: { kind: "control", csrfToken: "obsolete-control-csrf" }, roster: { revision: 1, entries: [] }, catalog: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await loadRoster();
    await controlLogout();
    await updateRoster(1, []);
    const options = fetchMock.mock.calls.at(-1)?.[1];
    expect(new Headers(options?.headers).get("X-AMFAA-CSRF")).toBe("");
  });

  it("does not restore an obsolete session when a pre-logout read finishes late", async () => {
    const { session } = fixture({ signedIn: true });
    await loadControlMe();
    let resolveMe!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((input) => String(input).endsWith("/me") ? new Promise<Response>((resolve) => { resolveMe = resolve; }) : Promise.resolve(new Response(null, { status: 204 }))));
    const oldRead = loadControlMe();
    await controlLogout();
    resolveMe(Response.json(session));
    await oldRead;
    expect(controlSessionSnapshot().session).toBeNull();
  });
});

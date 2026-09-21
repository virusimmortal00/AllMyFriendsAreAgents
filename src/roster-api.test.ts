// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initiateProviderSetup, loadRoster, refreshModelDiscovery } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("roster request authorization", () => {
  it("uses the member token for catalog refresh and a separate administrator token for provider setup", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ roster: { revision: 1, entries: [] }, catalog: [], access: { kind: "room-member", csrfToken: "member-proof" } }))
      .mockResolvedValueOnce(Response.json({ status: "available", models: [] }))
      .mockResolvedValueOnce(Response.json({ principal: { role: "OWNER" }, csrfToken: "control-proof" }))
      .mockResolvedValueOnce(Response.json({ mode: "server-local-handoff" }));
    vi.stubGlobal("fetch", fetchMock);
    await loadRoster();
    await refreshModelDiscovery();
    await initiateProviderSetup();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/roster", "/api/model-discovery/refresh", "/api/control/me", "/api/provider-setup/initiate"]);
    const [, refreshCall, , setupCall] = fetchMock.mock.calls;
    if (!refreshCall || !setupCall) throw new Error("Expected model refresh and provider setup requests.");
    expect(new Headers(refreshCall[1]?.headers).get("X-AMFAA-CSRF")).toBe("member-proof");
    expect(new Headers(setupCall[1]?.headers).get("X-AMFAA-CSRF")).toBe("control-proof");
  });

  it("does not attempt provider setup when only room membership is available", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: "Authenticate with the server control plane first." }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(initiateProviderSetup()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [sessionCall] = fetchMock.mock.calls;
    if (!sessionCall) throw new Error("Expected the control-session request.");
    expect(sessionCall[0]).toBe("/api/control/me");
  });
});

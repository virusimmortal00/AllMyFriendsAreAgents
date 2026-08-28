import { describe, expect, it, vi } from "vitest";
import {
  GitHubDeviceFlowClient,
  GitHubDeviceFlowFailure,
  publicGitHubDeviceChallenge,
  type GitHubOAuthFetch,
} from "./github-device-flow.js";

const clientId = "Ov23liDeviceFlowClient";
const deviceCode = "device_code_1234567890";
const accessToken = "ghu_access_token_1234567890";
const refreshToken = "ghr_refresh_token_1234567890";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("GitHub App device-flow transport", () => {
  it("starts at GitHub's fixed endpoint and exposes only the display-safe challenge", async () => {
    const fetcher = vi.fn<GitHubOAuthFetch>(async () => json({
      device_code: deviceCode,
      user_code: "ABCD-EFGH",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    }));
    const authorization = await new GitHubDeviceFlowClient(clientId, fetcher).start();

    expect(fetcher).toHaveBeenCalledWith("https://github.com/login/device/code", expect.objectContaining({ method: "POST", redirect: "error" }));
    const request = fetcher.mock.calls[0]![1]!;
    expect(String(request.body)).toBe(`client_id=${clientId}`);
    expect(String(request.body)).not.toMatch(/secret|device_code/);
    expect(publicGitHubDeviceChallenge(authorization)).toEqual({ userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresInSeconds: 900, intervalSeconds: 5 });
    expect(JSON.stringify(publicGitHubDeviceChallenge(authorization))).not.toContain(deviceCode);
  });

  it.each([
    [{ error: "authorization_pending" }, { kind: "pending", retryAfterSeconds: 5 }],
    [{ error: "slow_down" }, { kind: "slow-down", retryAfterSeconds: 10 }],
    [{ error: "access_denied" }, { kind: "denied" }],
    [{ error: "expired_token" }, { kind: "expired" }],
  ])("maps a bounded OAuth polling response without exposing upstream text", async (payload, expected) => {
    const fetcher = vi.fn<GitHubOAuthFetch>(async () => json(payload));
    await expect(new GitHubDeviceFlowClient(clientId, fetcher).poll(deviceCode, 5)).resolves.toEqual(expected);
    const body = String(fetcher.mock.calls[0]![1]?.body);
    expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
    expect(body).not.toContain("client_secret");
  });

  it("returns an authorized credential only to the server-side caller", async () => {
    const fetcher = vi.fn<GitHubOAuthFetch>(async () => json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 28_800,
      refresh_token: refreshToken,
      refresh_token_expires_in: 15_897_600,
    }));
    await expect(new GitHubDeviceFlowClient(clientId, fetcher).poll(deviceCode, 5)).resolves.toEqual({
      kind: "authorized",
      credential: { accessToken, tokenType: "bearer", expiresInSeconds: 28_800, refreshToken, refreshTokenExpiresInSeconds: 15_897_600 },
    });
  });

  it("refreshes a device-flow token without sending a client secret", async () => {
    const nextAccessToken = "ghu_next_access_token_1234567890";
    const nextRefreshToken = "ghr_next_refresh_token_1234567890";
    const fetcher = vi.fn<GitHubOAuthFetch>(async () => json({
      access_token: nextAccessToken,
      token_type: "bearer",
      expires_in: 28_800,
      refresh_token: nextRefreshToken,
      refresh_token_expires_in: 15_897_600,
    }));
    await expect(new GitHubDeviceFlowClient(clientId, fetcher).refresh(refreshToken)).resolves.toMatchObject({ accessToken: nextAccessToken, refreshToken: nextRefreshToken });
    const body = String(fetcher.mock.calls[0]![1]?.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain(`refresh_token=${refreshToken}`);
    expect(body).not.toContain("client_secret");
  });

  it("fails with redacted errors for malformed, oversized, disabled, and upstream responses", async () => {
    const cases: Array<{ fetcher: GitHubOAuthFetch; kind: string }> = [
      { fetcher: async () => new Response("not json"), kind: "invalid-response" },
      { fetcher: async () => new Response(JSON.stringify({ value: "x".repeat(33 * 1024) })), kind: "invalid-response" },
      { fetcher: async () => json({ error: "device_flow_disabled", error_description: "private upstream details" }), kind: "disabled" },
      { fetcher: async () => json({ error: "incorrect_client_credentials", error_description: "private upstream details" }), kind: "upstream" },
      { fetcher: async () => json({ error: "server" }, 500), kind: "upstream" },
    ];
    for (const value of cases) {
      try {
        await new GitHubDeviceFlowClient(clientId, value.fetcher).poll(deviceCode, 5);
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubDeviceFlowFailure);
        expect(error).toMatchObject({ kind: value.kind, message: `GitHub device flow failed (${value.kind}).` });
        expect(JSON.stringify(error)).not.toMatch(/private upstream details|device_code_123|ghu_|ghr_/);
      }
    }
  });
});

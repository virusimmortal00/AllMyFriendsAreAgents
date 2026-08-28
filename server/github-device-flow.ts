const DEVICE_CODE_ENDPOINT = "https://github.com/login/device/code";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const VERIFICATION_URI = "https://github.com/login/device";
const MAX_RESPONSE_BYTES = 32 * 1024;
const CLIENT_ID = /^[A-Za-z0-9._-]{10,200}$/;
const DEVICE_CODE = /^[A-Za-z0-9._-]{10,500}$/;
const USER_CODE = /^[A-Za-z0-9-]{4,40}$/;
const USER_ACCESS_TOKEN = /^ghu_[A-Za-z0-9_]{10,1000}$/;
const REFRESH_TOKEN = /^ghr_[A-Za-z0-9_]{10,1000}$/;

export type GitHubOAuthFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GitHubDeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: typeof VERIFICATION_URI;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

export interface PublicGitHubDeviceChallenge {
  readonly userCode: string;
  readonly verificationUri: typeof VERIFICATION_URI;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

export interface GitHubDeviceUserToken {
  readonly accessToken: string;
  readonly tokenType: "bearer";
  readonly expiresInSeconds?: number;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresInSeconds?: number;
}

export type GitHubDevicePollResult =
  | { readonly kind: "pending"; readonly retryAfterSeconds: number }
  | { readonly kind: "slow-down"; readonly retryAfterSeconds: number }
  | { readonly kind: "authorized"; readonly credential: GitHubDeviceUserToken }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" };

export type GitHubDeviceFlowFailureKind = "invalid-config" | "upstream" | "invalid-response" | "disabled";

/** Safe error that never embeds an upstream body, device code, or token. */
export class GitHubDeviceFlowFailure extends Error {
  constructor(readonly kind: GitHubDeviceFlowFailureKind) {
    super(`GitHub device flow failed (${kind}).`);
    this.name = "GitHubDeviceFlowFailure";
  }
}

/** Fixed-origin GitHub App device-flow transport. It does not persist credentials. */
export class GitHubDeviceFlowClient {
  constructor(private readonly clientId: string, private readonly fetcher: GitHubOAuthFetch = fetch) {
    if (!CLIENT_ID.test(clientId)) throw new GitHubDeviceFlowFailure("invalid-config");
  }

  async start(): Promise<GitHubDeviceAuthorization> {
    const payload = await this.post(DEVICE_CODE_ENDPOINT, { client_id: this.clientId });
    const authorization = {
      deviceCode: stringField(payload, "device_code"),
      userCode: stringField(payload, "user_code"),
      verificationUri: stringField(payload, "verification_uri"),
      expiresInSeconds: integerField(payload, "expires_in"),
      intervalSeconds: integerField(payload, "interval"),
    };
    if (!DEVICE_CODE.test(authorization.deviceCode) || !USER_CODE.test(authorization.userCode)
      || authorization.verificationUri !== VERIFICATION_URI || !boundedSeconds(authorization.expiresInSeconds, 1, 3_600)
      || !boundedSeconds(authorization.intervalSeconds, 1, 60)) throw new GitHubDeviceFlowFailure("invalid-response");
    return authorization as GitHubDeviceAuthorization;
  }

  async poll(deviceCode: string, intervalSeconds: number): Promise<GitHubDevicePollResult> {
    if (!DEVICE_CODE.test(deviceCode) || !boundedSeconds(intervalSeconds, 1, 60)) throw new GitHubDeviceFlowFailure("invalid-config");
    const payload = await this.post(TOKEN_ENDPOINT, {
      client_id: this.clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const error = optionalStringField(payload, "error");
    if (error === "authorization_pending") return { kind: "pending", retryAfterSeconds: intervalSeconds };
    if (error === "slow_down") return { kind: "slow-down", retryAfterSeconds: intervalSeconds + 5 };
    if (error === "access_denied") return { kind: "denied" };
    if (error === "expired_token") return { kind: "expired" };
    if (error === "device_flow_disabled") throw new GitHubDeviceFlowFailure("disabled");
    if (error) throw new GitHubDeviceFlowFailure("upstream");
    return { kind: "authorized", credential: tokenFrom(payload) };
  }

  async refresh(refreshToken: string): Promise<GitHubDeviceUserToken> {
    if (!REFRESH_TOKEN.test(refreshToken)) throw new GitHubDeviceFlowFailure("invalid-config");
    const payload = await this.post(TOKEN_ENDPOINT, {
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (optionalStringField(payload, "error")) throw new GitHubDeviceFlowFailure("upstream");
    return tokenFrom(payload);
  }

  private async post(endpoint: typeof DEVICE_CODE_ENDPOINT | typeof TOKEN_ENDPOINT, parameters: Readonly<Record<string, string>>) {
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(parameters).toString(),
      });
    } catch {
      throw new GitHubDeviceFlowFailure("upstream");
    }
    if (!response.ok) throw new GitHubDeviceFlowFailure("upstream");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new GitHubDeviceFlowFailure("invalid-response");
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new GitHubDeviceFlowFailure("invalid-response"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new GitHubDeviceFlowFailure("invalid-response");
    return payload as Record<string, unknown>;
  }
}

export function publicGitHubDeviceChallenge(authorization: GitHubDeviceAuthorization): PublicGitHubDeviceChallenge {
  return {
    userCode: authorization.userCode,
    verificationUri: authorization.verificationUri,
    expiresInSeconds: authorization.expiresInSeconds,
    intervalSeconds: authorization.intervalSeconds,
  };
}

function tokenFrom(payload: Record<string, unknown>): GitHubDeviceUserToken {
  const accessToken = stringField(payload, "access_token");
  const tokenType = stringField(payload, "token_type").toLowerCase();
  const expiresInSeconds = optionalIntegerField(payload, "expires_in");
  const refreshToken = optionalStringField(payload, "refresh_token");
  const refreshTokenExpiresInSeconds = optionalIntegerField(payload, "refresh_token_expires_in");
  if (!USER_ACCESS_TOKEN.test(accessToken) || tokenType !== "bearer"
    || (expiresInSeconds !== undefined && !boundedSeconds(expiresInSeconds, 1, 86_400))
    || (refreshToken !== undefined && !REFRESH_TOKEN.test(refreshToken))
    || (refreshTokenExpiresInSeconds !== undefined && !boundedSeconds(refreshTokenExpiresInSeconds, 1, 365 * 24 * 60 * 60))
    || ((refreshToken === undefined) !== (refreshTokenExpiresInSeconds === undefined))) throw new GitHubDeviceFlowFailure("invalid-response");
  return {
    accessToken,
    tokenType: "bearer",
    ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
    ...(refreshToken === undefined ? {} : { refreshToken, refreshTokenExpiresInSeconds }),
  };
}

function stringField(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  if (typeof value !== "string") throw new GitHubDeviceFlowFailure("invalid-response");
  return value;
}

function optionalStringField(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new GitHubDeviceFlowFailure("invalid-response");
  return value;
}

function integerField(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  if (!Number.isSafeInteger(value)) throw new GitHubDeviceFlowFailure("invalid-response");
  return value as number;
}

function optionalIntegerField(payload: Record<string, unknown>, field: string) {
  return payload[field] === undefined ? undefined : integerField(payload, field);
}

function boundedSeconds(value: number, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}


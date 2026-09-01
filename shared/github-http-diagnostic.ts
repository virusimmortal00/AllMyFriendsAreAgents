/** Additive diagnostic fields; absent on records written before HTTP evidence was retained. */
export interface GitHubHttpDiagnostic {
  readonly httpStatus?: number;
  readonly githubRequestId?: string;
}

export function validGitHubHttpDiagnostic(value: unknown): value is GitHubHttpDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { httpStatus, githubRequestId } = value as Record<string, unknown>;
  return (httpStatus === undefined || typeof httpStatus === "number" && Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)
    && (githubRequestId === undefined || typeof githubRequestId === "string" && /^[A-Fa-f0-9:]{1,100}$/.test(githubRequestId));
}

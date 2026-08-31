/** Additive diagnostic fields; absent on records written before HTTP evidence was retained. */
export interface GitHubHttpDiagnostic {
  readonly httpStatus?: number;
  readonly githubRequestId?: string;
}

export function validGitHubHttpDiagnostic(value: GitHubHttpDiagnostic) {
  return (value.httpStatus === undefined || Number.isSafeInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)
    && (value.githubRequestId === undefined || typeof value.githubRequestId === "string" && /^[A-Fa-f0-9:]{1,100}$/.test(value.githubRequestId));
}

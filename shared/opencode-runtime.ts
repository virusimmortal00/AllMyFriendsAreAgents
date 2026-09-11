/** A safe, browser-facing summary of the server's OpenCode executable check. */
export type OpenCodeRuntimeStatus = {
  state: "ready";
  checkedAt: string;
  version: string;
} | {
  state: "unavailable";
  checkedAt: string;
  reason: OpenCodeRuntimeUnavailableReason;
};

export type OpenCodeRuntimeUnavailableReason =
  | "command_not_found"
  | "not_executable"
  | "timed_out"
  | "unsupported_version"
  | "command_failed";

export function openCodeRuntimeStatusMessage(status: OpenCodeRuntimeStatus | undefined) {
  if (!status) return "CLI unavailable";
  if (status.state === "ready") return `OpenCode ${status.version} is ready`;
  if (status.reason === "command_not_found") return "The server cannot find the configured OpenCode executable.";
  if (status.reason === "not_executable") return "The configured OpenCode executable cannot be run by the server.";
  if (status.reason === "timed_out") return "The server's OpenCode version check timed out.";
  if (status.reason === "unsupported_version") return "The installed OpenCode version is not supported by this server.";
  return "The server could not run the OpenCode version check.";
}

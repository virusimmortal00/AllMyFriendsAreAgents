export type OperationLog = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown>,
) => Promise<unknown> | unknown;

/** Observability is best-effort and must never change the owning operation's outcome. */
export async function logOperationSafely(
  operationLog: OperationLog | undefined,
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown>,
) {
  try {
    await operationLog?.(level, event, fields);
  } catch {
    // Logging failures are intentionally isolated from command and lifecycle state.
  }
}

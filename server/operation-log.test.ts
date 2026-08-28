import { describe, expect, it, vi } from "vitest";
import { logOperationSafely } from "./operation-log.js";

describe("best-effort operation logging", () => {
  it("contains synchronous and asynchronous sink failures", async () => {
    const synchronous = vi.fn(() => { throw new Error("sync logger failed"); });
    const asynchronous = vi.fn(async () => { throw new Error("async logger failed"); });
    await expect(logOperationSafely(synchronous, "info", "operation.started", {})).resolves.toBeUndefined();
    await expect(logOperationSafely(asynchronous, "error", "operation.failed", {})).resolves.toBeUndefined();
    expect(synchronous).toHaveBeenCalledOnce();
    expect(asynchronous).toHaveBeenCalledOnce();
  });
});

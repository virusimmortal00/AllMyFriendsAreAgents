import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@opencode-ai/sdk/v2";
import { executeOpenCodeStructuredTurn, OpenCodeStructuredTurnCancelledError, type OpenCodeStructuredSdk } from "./opencode-structured-transport.js";

function assistant(structured: unknown): AssistantMessage {
  return {
    id: "message-1", sessionID: "session-1", role: "assistant", parentID: "user-1", modelID: "model", providerID: "provider", mode: "plan", agent: "plan",
    path: { cwd: "/project", root: "/project" }, cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, completed: 2 }, finish: "stop", structured,
  };
}

function client(structured: unknown): OpenCodeStructuredSdk {
  return {
    health: vi.fn(async () => ({ healthy: true as const, version: "1.18.25-amfaa.2" })),
    createSession: vi.fn(async () => "session-1"),
    prompt: vi.fn(async () => ({ info: assistant(structured) })),
    abort: vi.fn(async () => undefined),
  };
}

const input = {
  projectPath: "/project", providerId: "provider", modelId: "model", agent: "plan", prompt: "Take a room turn.",
};

describe("OpenCode structured transport", () => {
  it("captures and locally validates info.structured", async () => {
    const sdk = client({ schemaVersion: 1, action: "speak", reason: null, messages: ["Hello."], conversationState: "settled" });
    await expect(executeOpenCodeStructuredTurn(sdk, input)).resolves.toMatchObject({
      sessionId: "session-1", messageId: "message-1", structured: { action: "speak", messages: ["Hello."] }, tokens: { input: 10, output: 5 },
    });
    expect(sdk.createSession).toHaveBeenCalledTimes(1);
    expect(sdk.prompt).toHaveBeenCalledTimes(1);
  });

  it("makes one bounded same-session correction after a semantically invalid envelope", async () => {
    const sdk = client(undefined);
    vi.mocked(sdk.prompt)
      .mockResolvedValueOnce({ info: assistant({ schemaVersion: 1, action: "speak", reason: null, messages: [], conversationState: "settled" }) })
      .mockResolvedValueOnce({ info: assistant({ schemaVersion: 1, action: "speak", reason: null, messages: ["Corrected."], conversationState: "settled" }) });

    await expect(executeOpenCodeStructuredTurn(sdk, input)).resolves.toMatchObject({ structured: { messages: ["Corrected."] }, cost: 0.02, tokens: { input: 20, output: 10 } });
    expect(sdk.prompt).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sdk.prompt).mock.calls[1][1].prompt).toContain("previous structured room-turn result");
  });

  it("reuses an explicit compatible session without creating another", async () => {
    const sdk = client({ schemaVersion: 1, action: "yield", reason: "not_addressed" });
    await executeOpenCodeStructuredTurn(sdk, { ...input, sessionId: "existing" });
    expect(sdk.createSession).not.toHaveBeenCalled();
    expect(sdk.prompt).toHaveBeenCalledWith("existing", expect.anything(), undefined);
  });

  it("rejects stock servers, missing structured output, and invalid application shapes", async () => {
    const stock = client({ schemaVersion: 1, action: "yield", reason: "not_addressed" });
    vi.mocked(stock.health).mockResolvedValue({ healthy: true, version: "1.18.25" });
    await expect(executeOpenCodeStructuredTurn(stock, input)).rejects.toThrow(/approved downstream runtime/);
    await expect(executeOpenCodeStructuredTurn(client(undefined), input)).rejects.toThrow(/invalid structured room turn/);
    await expect(executeOpenCodeStructuredTurn(client({ schemaVersion: 1, action: "yield", reason: "not_addressed", explanation: "private" }), input)).rejects.toThrow(/invalid structured room turn/);
  });

  it("aborts the provider session and reports cancellation", async () => {
    const controller = new AbortController();
    const sdk = client({ schemaVersion: 1, action: "speak", messages: ["late"], conversationState: "settled" });
    vi.mocked(sdk.prompt).mockImplementation(async () => {
      controller.abort();
      await Promise.resolve();
      return { info: assistant({ schemaVersion: 1, action: "speak", messages: ["late"], conversationState: "settled" }) };
    });
    await expect(executeOpenCodeStructuredTurn(sdk, { ...input, signal: controller.signal })).rejects.toBeInstanceOf(OpenCodeStructuredTurnCancelledError);
    expect(sdk.abort).toHaveBeenCalledWith("session-1", "/project");
  });
});

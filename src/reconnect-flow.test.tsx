// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { ROOM_PROTOCOL_VERSION } from "../shared/protocol";
import App from "./App";
import { ApiRequestError } from "./api";
import { loadDraftSnapshot, loadPendingSend, saveDraftSnapshot, savePendingSend } from "./client-persistence";
import type { HumanPresence, RoomState } from "./types";

const api = vi.hoisted(() => ({
  checkReady: vi.fn(),
  joinRoom: vi.fn(),
  loadRoom: vi.fn(),
  loadWorkshop: vi.fn(),
  runAction: vi.fn(),
  sendMessage: vi.fn(),
  updateMyStyle: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("./api", async () => ({
  ...await vi.importActual<typeof import("./api")>("./api"),
  ...api,
}));

class ControlledEventSource {
  static instances: ControlledEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<() => void>>();
  private version = 0;
  private readonly streamId = `stream-${ControlledEventSource.instances.length + 1}`;

  constructor(readonly url: string) {
    ControlledEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {}

  emit(room: RoomState) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      kind: "snapshot",
      reason: "initial",
      continuity: "fresh",
      streamId: this.streamId,
      version: this.version,
      state: room,
    }) }));
  }

  emitEvent(event: object) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
  }

  fail() {
    this.onerror?.();
  }
}

const human: HumanPresence = {
  id: "browser-human-1234",
  name: "Reconnect Tester",
  style: DEFAULT_PARTICIPANT_STYLES.you,
};

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

function room(instanceId: string, messages: RoomState["messages"] = [], state: Partial<RoomState> = {}): RoomState {
  return {
    messages,
    settings: {
      roomName: "Reconnect Lab",
      topic: "Recovery",
      writableAgent: "nobody",
      conversationEnergy: "balanced",
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status: "idle",
    humans: [human],
    server: { instanceId, protocolVersion: ROOM_PROTOCOL_VERSION },
    ...state,
  };
}

async function renderConnected(messages: RoomState["messages"] = [], beforeRender?: () => void) {
  window.localStorage.setItem("all-my-friends-are-agents-human", JSON.stringify(human));
  beforeRender?.();
  render(<App />);
  await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(1));
  expect(ControlledEventSource.instances[0].url).toBe("/api/events");
  act(() => ControlledEventSource.instances[0].emit(room("server-before", messages)));
  return screen.findByRole("textbox", { name: "Message" });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  window.localStorage.clear();
  window.sessionStorage.clear();
  ControlledEventSource.instances = [];
  vi.stubGlobal("EventSource", ControlledEventSource);
  vi.spyOn(Math, "random").mockReturnValue(0);
  api.checkReady.mockResolvedValue({ instanceId: "ready", protocolVersion: ROOM_PROTOCOL_VERSION });
  api.joinRoom.mockResolvedValue(human);
  api.loadRoom.mockResolvedValue(room("load-only"));
  api.loadWorkshop.mockRejectedValue(new Error("not used"));
  api.runAction.mockResolvedValue({ accepted: true });
  api.sendMessage.mockImplementation(async (_text: string, clientMessageId: string) => ({
    accepted: true, duplicate: false, clientMessageId, messageId: `server-${clientMessageId}`,
  }));
  api.updateMyStyle.mockResolvedValue(human);
  api.updateSettings.mockResolvedValue(room("settings"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("rendered reconnect recovery", () => {
  it("applies contiguous state and message deltas, deduplicates delivery, and resyncs a version gap", async () => {
    const user = userEvent.setup();
    const composer = await renderConnected([{ id: "before", speaker: "you", text: "Before", timestamp: "2026-08-24T12:00:00.000Z" }]);
    const source = ControlledEventSource.instances[0];
    const nextMessage = { id: "after", speaker: "codex-sol" as const, text: "After", timestamp: "2026-08-24T12:00:01.000Z" };
    const { messages: _messages, ...deltaState } = room("server-before", [], { status: "working", activeGenerations: { active: "codex-sol" } });

    act(() => source.emitEvent({
      kind: "state-delta", streamId: "stream-1", fromVersion: 0, version: 1,
      state: deltaState,
    }));
    expect(screen.getByText("OpenCode [openai/gpt-5.6-sol] is typing...")).toBeTruthy();
    expect(screen.getByText("Before")).toBeTruthy();
    act(() => source.emitEvent({ kind: "messages-appended", streamId: "stream-1", fromVersion: 1, version: 2, messages: [nextMessage] }));
    expect(await screen.findByText("After")).toBeTruthy();
    act(() => source.emitEvent({ kind: "messages-appended", streamId: "stream-1", fromVersion: 1, version: 2, messages: [nextMessage] }));
    expect(screen.getAllByText("After")).toHaveLength(1);

    await user.type(composer, "preserved draft");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
    act(() => source.emitEvent({ kind: "messages-appended", streamId: "stream-1", fromVersion: 3, version: 4, messages: [] }));
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(2), { timeout: 2_000 });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => ControlledEventSource.instances[1].emit(room("server-restarted", [nextMessage])));
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("Before")).toBeNull();
    expect(screen.getAllByText("After")).toHaveLength(1);
  });

  it("adopts and persists a replacement identity after the server loses its session map", async () => {
    const replacement: HumanPresence = {
      ...human,
      id: "replacement-human-5678",
    };
    const pending = { clientMessageId: "pending-across-restart", text: "still needs confirmation" };
    api.joinRoom.mockResolvedValueOnce(human).mockResolvedValueOnce(replacement);
    const user = userEvent.setup();
    const composer = await renderConnected([], () => savePendingSend(window.localStorage, human.id, pending));
    await user.type(composer, "survives identity replacement");
    composer.blur();

    act(() => ControlledEventSource.instances[0].fail());
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(2), { timeout: 2_000 });

    expect(api.joinRoom).toHaveBeenLastCalledWith(human);
    expect(JSON.parse(window.localStorage.getItem("all-my-friends-are-agents-human") || "null")).toEqual(replacement);
    expect(loadDraftSnapshot(window.localStorage, replacement.id).text).toBe("survives identity replacement");
    expect(loadPendingSend(window.localStorage, replacement.id)).toEqual(pending);
    act(() => ControlledEventSource.instances[1].emit(room("server-after", [], { humans: [replacement] })));
    expect((await screen.findByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("survives identity replacement");
  });

  it("keeps one optimistic message through acknowledgement and replaces it once on the later delta", async () => {
    const user = userEvent.setup();
    const composer = await renderConnected();
    await user.type(composer, "Optimistic once");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(screen.getAllByText("Optimistic once")).toHaveLength(1);
    const clientMessageId = api.sendMessage.mock.calls[0][1];
    act(() => ControlledEventSource.instances[0].emitEvent({
      kind: "messages-appended", streamId: "stream-1", fromVersion: 0, version: 1,
      messages: [{ id: "authoritative", clientMessageId, humanId: human.id, speaker: "you", text: "Optimistic once", timestamp: "2026-08-24T12:00:00.000Z" }],
    }));
    expect(screen.getAllByText("Optimistic once")).toHaveLength(1);
  });

  it("does not offer a duplicate retry when the authoritative delta beats an ambiguous POST failure", async () => {
    let rejectSend!: (error: Error) => void;
    api.sendMessage.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    const user = userEvent.setup();
    const composer = await renderConnected();
    await user.type(composer, "Delta won the race");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    const clientMessageId = api.sendMessage.mock.calls[0][1];
    act(() => ControlledEventSource.instances[0].emitEvent({
      kind: "messages-appended", streamId: "stream-1", fromVersion: 0, version: 1,
      messages: [{ id: "delivered-first", clientMessageId, humanId: human.id, speaker: "you", text: "Delta won the race", timestamp: "2026-08-24T12:00:00.000Z" }],
    }));
    act(() => rejectSend(new ApiRequestError("Connection interrupted", true)));
    await waitFor(() => expect(screen.getAllByText("Delta won the race")).toHaveLength(1));
    expect(screen.queryByText(/Not sent — send now\?/)).toBeNull();
  });

  it("offers bounded join recovery without overlapping a manual retry", async () => {
    let resolveRetry!: (identity: { instanceId: string; protocolVersion: number }) => void;
    api.checkReady
      .mockRejectedValueOnce(new Error("Room is offline"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    window.localStorage.setItem("all-my-friends-are-agents-human", JSON.stringify(human));
    const user = userEvent.setup();
    render(<App />);

    const retry = await screen.findByRole("button", { name: "Retry now" });
    expect(screen.getByText(/Automatic retry is scheduled/)).toBeTruthy();
    await user.click(retry);
    expect(api.checkReady).toHaveBeenCalledTimes(2);
    expect((screen.getByRole("button", { name: "Retrying…" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Retrying…" }));
    expect(api.checkReady).toHaveBeenCalledTimes(2);
    act(() => resolveRetry({ instanceId: "ready", protocolVersion: ROOM_PROTOCOL_VERSION }));
  });

  it("returns from a failed join to name entry and clears the stale identity", async () => {
    api.checkReady.mockRejectedValueOnce(new Error("Room is offline"));
    window.localStorage.setItem("all-my-friends-are-agents-human", JSON.stringify(human));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Use a different name" }));
    expect(screen.getByRole("textbox", { name: "What should everyone call you?" })).toBeTruthy();
    expect(window.localStorage.getItem("all-my-friends-are-agents-human")).toBeNull();
  });

  it("shows typing only for active generation IDs and returns to idle after success and provider failure", async () => {
    await renderConnected();
    expect(screen.getByText("Room is idle")).toBeTruthy();

    act(() => ControlledEventSource.instances[0].emit(room("server-before", [], {
      status: "working",
      activeAgent: "claude-opus",
      activeGenerations: { successful: "codex-sol" },
    })));
    expect(screen.getByText("OpenCode [openai/gpt-5.6-sol] is typing...")).toBeTruthy();

    act(() => ControlledEventSource.instances[0].emit(room("server-before", [], {
      status: "working",
      activeAgent: "claude-opus",
      activeGenerations: {},
    })));
    expect(screen.getByText("Room is idle")).toBeTruthy();

    act(() => ControlledEventSource.instances[0].emit(room("server-before", [], {
      status: "working",
      activeGenerations: { failing: "claude-sonnet" },
    })));
    expect(screen.getByText("OpenCode [anthropic/claude-sonnet-5] is typing...")).toBeTruthy();

    act(() => ControlledEventSource.instances[0].emit(room("server-before", [], {
      status: "idle",
      activeGenerations: {},
      agentHealth: {
        "claude-sonnet": {
          status: "cooldown",
          reason: "provider_error",
          message: "Provider disconnected.",
          since: "2026-08-24T12:00:00.000Z",
        },
      },
    })));
    expect(screen.getByText("Room is idle")).toBeTruthy();
  });

  it("replaces stale typing state with the authoritative reconnect snapshot", async () => {
    await renderConnected();
    act(() => ControlledEventSource.instances[0].emit(room("server-before", [], {
      status: "working",
      activeGenerations: { abandoned: "cursor-gemini" },
    })));
    expect(screen.getByText("Cursor [Gemini 3.1 Pro] is typing...")).toBeTruthy();

    act(() => ControlledEventSource.instances[0].fail());
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(2), { timeout: 2_000 });
    act(() => ControlledEventSource.instances[1].emit(room("server-after", [], {
      status: "working",
      activeAgent: "cursor-gemini",
      activeGenerations: {},
    })));

    await waitFor(() => expect(screen.getByText("Room is idle")).toBeTruthy());
    expect(screen.queryByText(/typing\.\.\./)).toBeNull();
  });

  it("uses a collective label for different overlapping agents and a specific label when overlap has one agent", async () => {
    await renderConnected();
    act(() => ControlledEventSource.instances[0].emit(room("server-before", [], {
      activeGenerations: { first: "codex-sol", second: "codex-sol" },
    })));
    expect(screen.getByText("OpenCode [openai/gpt-5.6-sol] is typing...")).toBeTruthy();
    expect(screen.getByRole("status", { name: "OpenCode [openai/gpt-5.6-sol] is generating a response" })).toBeTruthy();

    act(() => ControlledEventSource.instances[0].emit(room("server-before", [], {
      activeGenerations: { first: "codex-sol", second: "claude-sonnet" },
    })));
    expect(screen.getByText("Agents are typing...")).toBeTruthy();
    expect(screen.getByRole("status", { name: "OpenCode [openai/gpt-5.6-sol] is generating a response" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "OpenCode [anthropic/claude-sonnet-5] is generating a response" })).toBeTruthy();
  });

  it("warns before resetting identity and preserves room state and draft when canceled", async () => {
    const user = userEvent.setup();
    const composer = await renderConnected([{ id: "history", speaker: "codex-sol", text: "Keep the room", timestamp: "2026-08-21T12:00:00.000Z" }]);
    await user.type(composer, "Keep my draft");
    await user.click(screen.getByRole("button", { name: "Change name" }));
    const dialog = screen.getByRole("alertdialog", { name: "Change your name?" });
    expect(dialog.textContent).toContain("resets your room identity");
    expect(dialog.textContent).toContain("saved draft will be deleted");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change name" }));
    expect(screen.getByText("Keep the room")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Keep my draft");
    expect(loadDraftSnapshot(window.localStorage, human.id).text).toBe("Keep my draft");
  });

  it("warns about an unsent message and clears identity persistence only after confirmation", async () => {
    await renderConnected([], () => {
      saveDraftSnapshot(window.localStorage, human.id, { text: "persisted draft", mentions: [] });
      savePendingSend(window.localStorage, human.id, { clientMessageId: "pending-1", text: "unsent message" });
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Change name" }));
    const dialog = screen.getByRole("alertdialog", { name: "Change your name?" });
    expect(dialog.textContent).toContain("unsent message will be deleted");
    expect(dialog.textContent).toContain("saved draft will be deleted");
    await user.click(screen.getByRole("button", { name: "Reset identity and change name" }));
    expect(await screen.findByRole("textbox", { name: "What should everyone call you?" })).toBeTruthy();
    expect(loadDraftSnapshot(window.localStorage, human.id).text).toBe("");
    expect(window.localStorage.getItem(`all-my-friends-are-agents-pending-send:${human.id}`)).toBeNull();
    expect(window.localStorage.getItem("all-my-friends-are-agents-human")).toBeNull();
  });

  it("uses one compact Improvements/Chat toggle without polluting history from chat menus", async () => {
    const user = userEvent.setup();
    const pushState = vi.spyOn(window.history, "pushState");
    await renderConnected();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(pushState).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Improvements" }));
    expect(window.location.pathname).toBe("/improvements");
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(pushState.mock.calls.map(([, , path]) => path)).toEqual(["/improvements", "/"]);

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(pushState).toHaveBeenCalledTimes(2);
  });

  it("keeps an ambiguous POST pending across reconnect and resends only after an explicit click with the same client ID", async () => {
    const user = userEvent.setup();
    let resolveResend!: (state: RoomState) => void;
    api.sendMessage
      .mockRejectedValueOnce(new ApiRequestError("The room connection was interrupted.", true))
      .mockImplementationOnce(() => new Promise<RoomState>((resolve) => { resolveResend = resolve; }));
    const composer = await renderConnected();

    await user.type(composer, "Did this land?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const pending = await screen.findByText(/Not sent — send now\?/);
    expect(pending.closest(".pending-send")?.textContent).toContain("Did this land?");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const originalClientId = api.sendMessage.mock.calls[0][1];
    expect(originalClientId).toMatch(/^message_/);

    act(() => ControlledEventSource.instances[0].fail());
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(2), { timeout: 2_000 });
    expect((screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement).disabled).toBe(true);

    act(() => ControlledEventSource.instances[1].emit(room("server-after")));
    await waitFor(() => expect((screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement).disabled).toBe(false));
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Not sent — send now\?/)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    expect(api.sendMessage.mock.calls[1]).toEqual(["Did this land?", originalClientId, []]);
    expect((screen.getByRole("button", { name: "Sending…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Keep as draft" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => resolveResend(room("server-after")));
    await waitFor(() => expect(screen.queryByText(/Not sent — send now\?/)).toBeNull());
  });

  it("preserves a draft while disconnected and enables sending only after the reconnect SSE snapshot", async () => {
    const user = userEvent.setup();
    const before = { id: "before", speaker: "you" as const, text: "Before outage", timestamp: "2026-08-21T12:00:00.000Z" };
    const during = { id: "during", speaker: "codex-sol" as const, text: "Arrived during recovery", timestamp: "2026-08-21T12:00:01.000Z" };
    const composer = await renderConnected([before]);
    await user.type(composer, "Keep this draft");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);

    act(() => ControlledEventSource.instances[0].fail());
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Keep this draft");
    await waitFor(() => expect(loadDraftSnapshot(window.localStorage, human.id).text).toBe("Keep this draft"));
    expect(screen.getByText("Before outage")).not.toBeNull();

    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(2), { timeout: 2_000 });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Keep this draft");

    act(() => ControlledEventSource.instances[1].emit(room("server-after", [before, during])));
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(screen.getByText("Before outage")).not.toBeNull();
    expect(screen.getByText("Arrived during recovery")).not.toBeNull();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("rolls back a failed style save and lets the user dismiss its error", async () => {
    const user = userEvent.setup();
    api.updateMyStyle.mockRejectedValueOnce(new Error("Style save failed"));
    await renderConnected();
    const bold = screen.getByRole("button", { name: "Bold" });
    await user.click(bold);
    await waitFor(() => expect(bold.getAttribute("aria-pressed")).toBe("false"));
    expect(screen.getByRole("alert").textContent).toContain("Style save failed");
    await user.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("distinguishes transient workshop failure from verified missing and preserves return focus", async () => {
    api.loadWorkshop
      .mockRejectedValueOnce(new ApiRequestError("Temporary workshop failure", false, 503))
      .mockRejectedValueOnce(new ApiRequestError("Not found", false, 404));
    const user = userEvent.setup();
    await renderConnected([{ id: "ref", speaker: "you", text: "See [[improvement:imp-7]].", timestamp: "2026-08-21T12:00:00.000Z" }]);
    const reference = screen.getByRole("button", { name: "Open Improvement imp-7" });
    await user.click(reference);
    const dialog = await screen.findByRole("dialog", { name: "Improvement workshop" });
    expect(within(dialog).getByRole("alert").textContent).toContain("Temporary workshop failure");
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText(/verified not found/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(reference));
  });

  it("ignores a late workshop failure after the dialog closes", async () => {
    let rejectLoad!: (error: Error) => void;
    api.loadWorkshop.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLoad = reject; }));
    const user = userEvent.setup();
    await renderConnected([{ id: "ref", speaker: "you", text: "See [[improvement:imp-late]].", timestamp: "2026-08-21T12:00:00.000Z" }]);
    const reference = screen.getByRole("button", { name: "Open Improvement imp-late" });
    await user.click(reference);
    const dialog = await screen.findByRole("dialog", { name: "Improvement workshop" });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    act(() => rejectLoad(new Error("Late workshop failure")));
    await waitFor(() => expect(document.activeElement).toBe(reference));
    expect(screen.queryByRole("dialog", { name: "Improvement workshop" })).toBeNull();
    expect(screen.queryByText("Late workshop failure")).toBeNull();
  });

  it("identifies a failed room action, blocks duplicates, and permits only one safe retry after reconnect", async () => {
    let rejectFirst!: (error: Error) => void;
    let rejectRetry!: (error: Error) => void;
    api.runAction
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRetry = reject; }));
    const user = userEvent.setup();
    await renderConnected();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Continue discussion" }));
    expect(api.runAction).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain("Other room actions are unavailable");
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getAllByRole("menuitem").every((item) => (item as HTMLButtonElement).disabled)).toBe(true);
    act(() => rejectFirst(new Error("Action service failed")));

    const retry = await screen.findByRole("button", { name: "Retry once" });
    expect(screen.getByRole("alert").textContent).toContain("Continue discussion failed");
    act(() => ControlledEventSource.instances[0].fail());
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole("alert").textContent).toContain("Retry is unavailable while reconnecting");
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(2), { timeout: 2_000 });
    act(() => ControlledEventSource.instances[1].emit(room("server-after")));
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    await user.click(retry);
    expect(api.runAction).toHaveBeenCalledTimes(2);
    act(() => rejectRetry(new Error("Retry failed")));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("The retry failed"));
    expect(screen.queryByRole("button", { name: "Retry once" })).toBeNull();
  });

  it("does not offer duplicate-prone retry when a room action outcome is unknown", async () => {
    api.runAction.mockRejectedValueOnce(new ApiRequestError("Connection interrupted", true));
    const user = userEvent.setup();
    await renderConnected();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Start roundtable" }));
    expect((await screen.findByRole("alert")).textContent).toContain("retrying could duplicate the action");
    expect(screen.queryByRole("button", { name: "Retry once" })).toBeNull();
  });

  it("ignores a late room-action failure after identity reset", async () => {
    let rejectAction!: (error: Error) => void;
    api.runAction.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectAction = reject; }));
    const user = userEvent.setup();
    await renderConnected();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Continue discussion" }));
    await user.click(screen.getByRole("button", { name: "Change name" }));
    await user.click(screen.getByRole("button", { name: "Reset identity and change name" }));
    act(() => rejectAction(new Error("Late action failure")));
    expect(await screen.findByRole("textbox", { name: "What should everyone call you?" })).toBeTruthy();
    expect(screen.queryByText("Late action failure")).toBeNull();
  });
});

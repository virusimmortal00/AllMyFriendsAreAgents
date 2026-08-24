// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { ROOM_PROTOCOL_VERSION } from "../shared/protocol";
import App from "./App";
import { ApiRequestError } from "./api";
import { loadDraftSnapshot, saveDraftSnapshot, savePendingSend } from "./client-persistence";
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
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(room) }));
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
  api.updateMyStyle.mockResolvedValue(human);
  api.updateSettings.mockResolvedValue(room("settings"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("rendered reconnect recovery", () => {
  it("shows typing only for active generation IDs and returns to idle after success and provider failure", async () => {
    await renderConnected();
    expect(screen.getByText("Room is idle")).toBeTruthy();

    act(() => ControlledEventSource.instances[0].emit(room("server-before", [], {
      status: "working",
      activeAgent: "claude-opus",
      activeGenerations: { successful: "codex-sol" },
    })));
    expect(screen.getByText("Codex [gpt-5.6 Sol] is typing...")).toBeTruthy();

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
    expect(screen.getByText("Claude [Claude Sonnet 5] is typing...")).toBeTruthy();

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
    expect(screen.getByText("Codex [gpt-5.6 Sol] is typing...")).toBeTruthy();

    act(() => ControlledEventSource.instances[0].emit(room("server-before", [], {
      activeGenerations: { first: "codex-sol", second: "claude-opus" },
    })));
    expect(screen.getByText("Agents are typing...")).toBeTruthy();
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
    const originalClientId = api.sendMessage.mock.calls[0][2];
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
    expect(api.sendMessage.mock.calls[1]).toEqual([human.id, "Did this land?", originalClientId, []]);
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
});

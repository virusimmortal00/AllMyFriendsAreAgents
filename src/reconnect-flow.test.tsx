// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { ROOM_PROTOCOL_VERSION } from "../shared/protocol";
import App from "./App";
import { ApiRequestError } from "./api";
import { loadDraftSnapshot } from "./client-persistence";
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

function room(instanceId: string, messages: RoomState["messages"] = []): RoomState {
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
  };
}

async function renderConnected(messages: RoomState["messages"] = []) {
  window.localStorage.setItem("all-my-friends-are-agents-human", JSON.stringify(human));
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

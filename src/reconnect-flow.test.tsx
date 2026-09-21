// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { ROOM_PROTOCOL_VERSION } from "../shared/protocol";
import App from "./App";
import { updateControlSession } from "./control-session-state";
import { ApiRequestError } from "./api";
import { loadDraftSnapshot, loadPendingSend, saveDraftSnapshot, savePendingSend } from "./client-persistence";
import { TRANSCRIPT_MESSAGE_PRICES_STORAGE_KEY, TRANSCRIPT_SYSTEM_ACTIVITY_STORAGE_KEY, TRANSCRIPT_TIMESTAMPS_STORAGE_KEY } from "./transcript-view";
import type { HumanPresence, RoomState } from "./types";
import { legacyDefaultRoomAgentRoster } from "../shared/roster";

const api = vi.hoisted(() => ({
  checkReady: vi.fn(),
  joinRoom: vi.fn(),
  loadRoom: vi.fn(),
  loadPolls: vi.fn(),
  loadWorkshop: vi.fn(),
  sendMessage: vi.fn(),
  updateMyAvatar: vi.fn(),
  updateMyProfile: vi.fn(),
  updateMyStyle: vi.fn(),
  updateSettings: vi.fn(),
  voteOnPoll: vi.fn(),
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

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values.at(index);
  if (value === undefined) throw new Error(`Expected ${label} at index ${index}.`);
  return value;
}

function eventSourceAt(index: number) {
  return requiredAt(ControlledEventSource.instances, index, "controlled event source");
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
      conversationEnergy: "balanced",
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status: "idle",
    roster: legacyDefaultRoomAgentRoster(),
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
  const source = eventSourceAt(0);
  expect(source.url).toBe("/api/events");
  act(() => source.emit(room("server-before", messages)));
  return screen.findByRole("textbox", { name: "Message" });
}

async function chooseMenuItem(user: ReturnType<typeof userEvent.setup>, menuName: string, itemName: string) {
  await user.click(screen.getByRole("menuitem", { name: menuName }));
  const menu = within(screen.getByRole("menu", { name: menuName }));
  const item = menu.queryByRole("menuitemradio", { name: itemName })
    ?? menu.queryByRole("menuitemcheckbox", { name: itemName })
    ?? menu.getByRole("menuitem", { name: itemName });
  await user.click(item);
}

beforeEach(() => {
  updateControlSession({ status: null, session: null, checked: false, error: "" });
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
  api.loadPolls.mockResolvedValue({ items: [] });
  api.voteOnPoll.mockResolvedValue({ kind: "accepted" });
  api.loadWorkshop.mockRejectedValue(new Error("not used"));
  api.sendMessage.mockImplementation(async (_text: string, clientMessageId: string) => ({
    accepted: true, duplicate: false, clientMessageId, messageId: `server-${clientMessageId}`,
  }));
  api.updateMyStyle.mockResolvedValue(human);
  api.updateMyAvatar.mockResolvedValue(human);
  api.updateMyProfile.mockResolvedValue(human);
  api.updateSettings.mockResolvedValue(room("settings"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("rendered reconnect recovery", () => {
  it("keeps a saved roster participant in the room rail when the CLI is unavailable", async () => {
    await renderConnected();
    const agentId = "agent-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    act(() => eventSourceAt(0).emit(room("server-before", [], {
      roster: {
        schemaVersion: 3,
        revision: 2,
        entries: [{ agentId, conversationalName: "Scout", providerId: "openrouter", modelId: "example/scout", enabled: true }],
      },
      availability: { [agentId]: false },
      openCodeRuntime: { state: "unavailable", reason: "command_not_found", checkedAt: "2026-09-11T00:00:00.000Z" },
    })));

    expect(await screen.findByRole("button", { name: "Configure Scout: Scout via OpenRouter" })).toBeTruthy();
    expect(screen.getByText("CLI unavailable")).toBeTruthy();
    expect(screen.getByLabelText("Scout: Scout via OpenRouter: The server cannot find the configured OpenCode executable.")).toBeTruthy();
  });

  it("applies contiguous state and message deltas, deduplicates delivery, and resyncs a version gap", async () => {
    const user = userEvent.setup();
    const composer = await renderConnected([{ id: "before", speaker: "you", text: "Before", timestamp: "2026-08-24T12:00:00.000Z" }]);
    const source = eventSourceAt(0);
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
    act(() => eventSourceAt(1).emit(room("server-restarted", [nextMessage])));
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

    act(() => eventSourceAt(0).fail());
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(2), { timeout: 2_000 });

    expect(api.joinRoom).toHaveBeenLastCalledWith(human);
    expect(JSON.parse(window.localStorage.getItem("all-my-friends-are-agents-human") || "null")).toEqual(replacement);
    expect(loadDraftSnapshot(window.localStorage, replacement.id).text).toBe("survives identity replacement");
    expect(loadPendingSend(window.localStorage, replacement.id)).toEqual(pending);
    act(() => eventSourceAt(1).emit(room("server-after", [], { humans: [replacement] })));
    expect((await screen.findByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("survives identity replacement");
  });

  it("keeps one optimistic message through acknowledgement and replaces it once on the later delta", async () => {
    const user = userEvent.setup();
    const composer = await renderConnected();
    await user.type(composer, "Optimistic once");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(screen.getAllByText("Optimistic once")).toHaveLength(1);
    const clientMessageId = requiredAt(api.sendMessage.mock.calls, 0, "send-message call")[1];
    act(() => eventSourceAt(0).emitEvent({
      kind: "messages-appended", streamId: "stream-1", fromVersion: 0, version: 1,
      messages: [{ id: "authoritative", clientMessageId, humanId: human.id, speaker: "you", text: "Optimistic once", timestamp: "2026-08-24T12:00:00.000Z" }],
    }));
    expect(screen.getAllByText("Optimistic once")).toHaveLength(1);
  });

  it("never inserts a slash command optimistically before its private response arrives", async () => {
    let resolveCommand!: (value: unknown) => void;
    api.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { resolveCommand = resolve; }));
    const user = userEvent.setup();
    const composer = await renderConnected();
    await user.type(composer, "/help");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(screen.queryByText("/help")).toBeNull();
    act(() => resolveCommand({ command: true, clientSubmissionId: requiredAt(api.sendMessage.mock.calls, 0, "command call")[1], result: { kind: "private-help", commands: ["help"] } }));
    expect(screen.queryByText("/help")).toBeNull();
    expect(screen.queryByText("Commands: /help")).toBeNull();
    act(() => eventSourceAt(0).emitEvent({kind:"messages-appended",streamId:"stream-1",fromVersion:0,version:1,messages:[{id:"private-help",speaker:"system",kind:"status",text:"Room commands available to you:\n/help — List commands",timestamp:"2026-08-27T12:00:00Z"}]}));
    expect(await screen.findByText(/Room commands available to you/)).toBeTruthy();
  });

  it("keeps command errors private to the invoker instead of projecting raw slash text", async () => {
    api.sendMessage.mockImplementationOnce(async (_text: string, clientSubmissionId: string) => ({ command: true, clientSubmissionId, result: { kind: "private-error", message: "Only room owners may run that command." } }));
    const user = userEvent.setup();
    const composer = await renderConnected([{ id: "audit", speaker: "system", text: "— Ada ran a command —", timestamp: "2026-08-24T12:00:00.000Z", kind: "status" }]);
    await user.type(composer, "/task secret diagnostic");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Only room owners may run that command.")).toBeTruthy();
    expect(screen.queryByText("/task secret diagnostic")).toBeNull();
    expect(screen.queryByText("secret diagnostic")).toBeNull();
  });

  it("renders ordered authoritative poll tallies and replaces them after a vote without optimistic duplication", async () => {
    const initial = { pollId: "poll-1", question: "Choose a path", options: ["B", "A"], tallies: [2, 1], totalVotes: 3,state:"OPEN" as const,revision:1,closedAt:null,ownVote:null,canClose:true };
    const projected = { ...initial, tallies: [2, 2], totalVotes: 4 };
    api.loadPolls.mockResolvedValueOnce({ items: [initial] }).mockResolvedValueOnce({ items: [projected] });
    const user = userEvent.setup();
    await renderConnected();
    expect(await screen.findByRole("region", { name: "Room polls" })).toBeTruthy();
    const options = screen.getAllByRole("button", { name: /Vote for/ });
    expect(options.map((option) => option.textContent)).toEqual(["B", "A"]);
    expect(screen.getByLabelText("2 votes")).toBeTruthy();
    await user.click(options[1]!);
    await waitFor(() => expect(api.voteOnPoll).toHaveBeenCalledWith("poll-1", 1));
    expect(await screen.findByText("4 votes")).toBeTruthy();
    expect(screen.getAllByText("2")).toHaveLength(2);
  });

  it("does not offer a duplicate retry when the authoritative delta beats an ambiguous POST failure", async () => {
    let rejectSend!: (error: Error) => void;
    api.sendMessage.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    const user = userEvent.setup();
    const composer = await renderConnected();
    await user.type(composer, "Delta won the race");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    const clientMessageId = requiredAt(api.sendMessage.mock.calls, 0, "send-message call")[1];
    act(() => eventSourceAt(0).emitEvent({
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

    act(() => eventSourceAt(0).emit(room("server-before", [], {
      status: "working",
      activeAgent: "claude-opus",
      activeGenerations: { successful: "codex-sol" },
    })));
    expect(screen.getByText("OpenCode [openai/gpt-5.6-sol] is typing...")).toBeTruthy();

    act(() => eventSourceAt(0).emit(room("server-before", [], {
      status: "working",
      activeAgent: "claude-opus",
      activeGenerations: {},
    })));
    expect(screen.getByText("Room is idle")).toBeTruthy();

    act(() => eventSourceAt(0).emit(room("server-before", [], {
      status: "working",
      activeGenerations: { failing: "claude-sonnet" },
    })));
    expect(screen.getByText("OpenCode [anthropic/claude-sonnet-5] is typing...")).toBeTruthy();

    act(() => eventSourceAt(0).emit(room("server-before", [], {
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
    act(() => eventSourceAt(0).emit(room("server-before", [], {
      status: "working",
      activeGenerations: { abandoned: "cursor-gemini" },
    })));
    expect(screen.getByText("Cursor [Gemini 3.1 Pro] is typing...")).toBeTruthy();

    act(() => eventSourceAt(0).fail());
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(2), { timeout: 2_000 });
    act(() => eventSourceAt(1).emit(room("server-after", [], {
      status: "working",
      activeAgent: "cursor-gemini",
      activeGenerations: {},
    })));

    await waitFor(() => expect(screen.getByText("Room is idle")).toBeTruthy());
    expect(screen.queryByText(/typing\.\.\./)).toBeNull();
  });

  it("uses a collective label for different overlapping agents and a specific label when overlap has one agent", async () => {
    await renderConnected();
    act(() => eventSourceAt(0).emit(room("server-before", [], {
      activeGenerations: { first: "codex-sol", second: "codex-sol" },
    })));
    expect(screen.getByText("OpenCode [openai/gpt-5.6-sol] is typing...")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Sol is generating a response" })).toBeTruthy();

    act(() => eventSourceAt(0).emit(room("server-before", [], {
      activeGenerations: { first: "codex-sol", second: "claude-sonnet" },
    })));
    expect(screen.getByText("Agents are typing...")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Sol is generating a response" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Claude is generating a response" })).toBeTruthy();
  });

  it("opens Manage Agents on the exact activated roster row and restores focus to that row", async () => {
    const roster = {
      schemaVersion: 3 as const,
      revision: 4,
      entries: [
        { agentId: "codex-sol" as const, conversationalName: "Sol", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true },
        { agentId: "claude-opus" as const, conversationalName: "Opus", providerId: "anthropic", modelId: "claude-opus-5", enabled: true },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      roster,
      access: { kind: "room-member", csrfToken: "member-csrf" },
      modelDiscovery: { status: "available", models: [] },
      catalog: [
        { agentId: "codex-sol", provider: "openai", modelId: "gpt-5.6-sol", conversationalName: "Sol" },
        { agentId: "claude-opus", provider: "anthropic", modelId: "claude-opus-5", conversationalName: "Opus" },
      ],
    }), { status: 200 })));
    const user = userEvent.setup();
    await renderConnected();
    act(() => eventSourceAt(0).emit(room("server-before", [], { roster })));
    const row = screen.getByRole("button", { name: /Configure Opus:/ });

    await user.dblClick(row);

    expect((await screen.findByRole("button", { name: "View Opus configuration" })).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "View Sol configuration" }).getAttribute("aria-pressed")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Close roster manager" }));
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("keeps profile edits local when canceled and restores focus to You", async () => {
    const user = userEvent.setup();
    const composer = await renderConnected([{ id: "history", speaker: "codex-sol", text: "Keep the room", timestamp: "2026-08-21T12:00:00.000Z" }]);
    await user.type(composer, "Keep my draft");
    await chooseMenuItem(user, "You", "Profile...");
    const dialog = screen.getByRole("dialog", { name: "Your profile" });
    const name = within(dialog).getByRole("textbox", { name: "Display name" });
    await user.clear(name);
    await user.type(name, "Grace Hopper");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Your profile" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "You" }));
    expect(screen.getByText("Keep the room")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Keep my draft");
    expect(loadDraftSnapshot(window.localStorage, human.id).text).toBe("Keep my draft");
    expect(api.updateMyProfile).not.toHaveBeenCalled();
  });

  it("edits room settings in a modal and restores focus after save", async () => {
    const user = userEvent.setup();
    await renderConnected();
    const trigger = screen.getByRole("menuitem", { name: "Room" });

    await chooseMenuItem(user, "Room", "Room properties...");
    const dialog = screen.getByRole("dialog", { name: "Room Properties" });
    expect(within(dialog).getByRole("tab", { name: "General" })).toBeTruthy();
    expect(within(dialog).getByRole("tab", { name: "Agent behavior" })).toBeTruthy();
    const roomName = within(dialog).getByRole("textbox", { name: "Room name" });
    await user.clear(roomName);
    await user.type(roomName, "Editable Room");
    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({
      roomName: "Editable Room",
      topic: "Recovery",
      conversationEnergy: "balanced",
    }));
    expect(screen.queryByRole("dialog", { name: "Room Properties" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps Room Properties editable while agents are responding", async () => {
    const user = userEvent.setup();
    await renderConnected();
    act(() => eventSourceAt(0).emit(room("working-settings", [], {
      status: "working",
      activeGenerations: { response: "codex-sol" },
    })));
    await screen.findByRole("status", { name: "Sol is generating a response" });

    await chooseMenuItem(user, "Room", "Room properties...");
    const dialog = screen.getByRole("dialog", { name: "Room Properties" });
    const roomName = within(dialog).getByRole("textbox", { name: "Room name" }) as HTMLInputElement;
    const topic = within(dialog).getByRole("textbox", { name: "Topic" }) as HTMLInputElement;
    const energy = within(dialog).getByRole("combobox", { name: "Conversation energy" }) as HTMLSelectElement;

    expect(roomName.disabled).toBe(false);
    expect(topic.disabled).toBe(false);
    expect(energy.disabled).toBe(false);
    await user.clear(topic);
    await user.type(topic, "Editable during a response");
    expect(topic.value).toBe("Editable during a response");
  });

  it("opens room name and topic settings from the participant-pane Properties button", async () => {
    const user = userEvent.setup();
    await renderConnected();
    const trigger = screen.getByRole("button", { name: "Properties..." });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Room Properties" });
    expect(within(dialog).getByRole("textbox", { name: "Room name" })).toBeTruthy();
    expect(within(dialog).getByRole("textbox", { name: "Topic" })).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: "Room Properties" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps unsaved Room Properties edits intact when F1 is pressed", async () => {
    const user = userEvent.setup();
    await renderConnected();
    await chooseMenuItem(user, "Room", "Room properties...");
    const dialog = screen.getByRole("dialog", { name: "Room Properties" });
    const topic = within(dialog).getByRole("textbox", { name: "Topic" });
    await user.clear(topic);
    await user.type(topic, "Unsaved topic draft");

    await user.keyboard("{F1}");

    expect(screen.getByRole("dialog", { name: "Room Properties" })).toBe(dialog);
    expect((topic as HTMLInputElement).value).toBe("Unsaved topic draft");
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
  });

  it("puts You first, removes People and Change name, and drops retired room actions", async () => {
    const user = userEvent.setup();
    await renderConnected();
    const topLevelMenus = screen.getAllByRole("menuitem");
    expect(topLevelMenus[0]?.textContent).toBe("You");
    expect(topLevelMenus.map((menu) => menu.textContent)).toEqual(["You", "Room", "Server", "View", "Help"]);

    await user.click(screen.getByRole("menuitem", { name: "Room" }));
    const roomMenu = within(screen.getByRole("menu", { name: "Room" }));
    expect(roomMenu.queryByRole("menuitem", { name: "People..." })).toBeNull();
    expect(roomMenu.queryByRole("menuitem", { name: "Change name..." })).toBeNull();
    expect(roomMenu.queryByRole("menuitem", { name: "Room settings..." })).toBeNull();
    expect(roomMenu.getByRole("menuitem", { name: "Manage agents..." })).toBeTruthy();
    for (const name of ["Continue discussion", "Start roundtable", "Review with all agents"]) {
      expect(roomMenu.queryByRole("menuitem", { name })).toBeNull();
    }
    expect((roomMenu.getByRole("menuitem", { name: "Assign task..." }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers no workspace switcher and returns retired improvement links to Chat", async () => {
    window.history.replaceState({}, "", "/improvements/known-id");
    const user = userEvent.setup();
    await renderConnected();
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("menuitem", { name: "Window" })).toBeNull();
    for (const name of ["Improvements", "Tasks", "Continuations", "Investigations", "Reviewed contributions"]) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
    }
  });

  it("assigns a task to a chosen agent through the existing /task command", async () => {
    api.sendMessage.mockResolvedValueOnce({ command: true, result: { kind: "accepted" } });
    const user = userEvent.setup();
    await renderConnected();
    const roomTrigger = screen.getByRole("menuitem", { name: "Room" });
    await chooseMenuItem(user, "Room", "Assign task...");
    const dialog = within(screen.getByRole("dialog", { name: "Assign task" }));
    const agent = requiredAt(legacyDefaultRoomAgentRoster().entries.filter((entry) => entry.enabled), 0, "enabled roster agent");
    await user.selectOptions(dialog.getByRole("combobox", { name: "Agent" }), agent.agentId);
    await user.type(dialog.getByRole("textbox", { name: "Task" }), "  inspect the error path  ");
    await user.click(dialog.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(`/task @${agent.agentId} inspect the error path`, expect.stringMatching(/^message_/), []));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Assign task" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(roomTrigger));
  });

  it("keeps the Assign task draft open and explains a rejected command", async () => {
    api.sendMessage.mockResolvedValueOnce({ command: true, result: { kind: "private-error", message: "That participant is not in the room roster." } });
    const user = userEvent.setup();
    await renderConnected();
    await user.pointer({ keys: "[MouseRight]", target: screen.getAllByRole("button", { name: /^Configure / })[0] });
    const dialog = within(screen.getByRole("dialog", { name: "Assign task" }));
    await user.type(dialog.getByRole("textbox", { name: "Task" }), "check the retry path");
    await user.click(dialog.getByRole("button", { name: "OK" }));
    expect(await dialog.findByRole("alert")).toHaveProperty("textContent", "That participant is not in the room roster.");
    expect((dialog.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement).value).toBe("check the retry path");
  });

  it("opens the existing Manage Agents dialog from the Room menu and restores focus", async () => {
    const roster = {
      schemaVersion: 3 as const,
      revision: 4,
      entries: [{ agentId: "codex-sol" as const, conversationalName: "Sol", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      roster,
      catalog: [{ agentId: "codex-sol", provider: "openai", modelId: "gpt-5.6-sol", conversationalName: "Sol" }],
    }), { status: 200 })));
    const user = userEvent.setup();
    await renderConnected();
    act(() => eventSourceAt(0).emit(room("server-before", [], { roster })));
    const roomTrigger = screen.getByRole("menuitem", { name: "Room" });

    await chooseMenuItem(user, "Room", "Manage agents...");
    expect(await screen.findByRole("dialog", { name: "Manage room agents" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "View Sol configuration" }).getAttribute("aria-pressed"))).toBe("true");
    await user.click(screen.getByRole("button", { name: "Close roster manager" }));
    await waitFor(() => expect(document.activeElement).toBe(roomTrigger));
  });

  it("updates the profile without replacing identity or clearing drafts and pending sends", async () => {
    api.updateMyProfile.mockResolvedValueOnce({ ...human, name: "Grace Hopper" });
    await renderConnected([], () => {
      saveDraftSnapshot(window.localStorage, human.id, { text: "persisted draft", mentions: [] });
      savePendingSend(window.localStorage, human.id, { clientMessageId: "pending-1", text: "unsent message" });
    });
    const user = userEvent.setup();
    await chooseMenuItem(user, "You", "Profile...");
    const name = screen.getByRole("textbox", { name: "Display name" });
    await user.clear(name);
    await user.type(name, "Grace Hopper");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(api.updateMyProfile).toHaveBeenCalledWith({ name: "Grace Hopper", avatarUrl: undefined }));
    expect(loadDraftSnapshot(window.localStorage, human.id).text).toBe("persisted draft");
    expect(loadPendingSend(window.localStorage, human.id)?.text).toBe("unsent message");
    expect(JSON.parse(window.localStorage.getItem("all-my-friends-are-agents-human") || "null")).toMatchObject({ id: human.id, name: "Grace Hopper" });
    expect(screen.queryByRole("textbox", { name: "What should everyone call you?" })).toBeNull();
  });

  it("opens Server Administration as a window at the chosen Server menu page and restores focus on close", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input) === "/api/control/status"
      ? Response.json({ claimed: true, bootstrapConfigured: true })
      : Response.json({ error: "Sign in required" }, { status: 401 })));
    const user = userEvent.setup();
    const pushState = vi.spyOn(window.history, "pushState");
    await renderConnected();

    expect(screen.queryByRole("menuitem", { name: "Actions" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "View" }));
    expect(within(screen.getByRole("menu", { name: "View" })).queryByRole("menuitemradio", { name: "Diagnostics" })).toBeNull();
    await user.keyboard("{Escape}");

    const serverTrigger = screen.getByRole("menuitem", { name: "Server" });
    await user.click(serverTrigger);
    const serverCommands = within(screen.getByRole("menu", { name: "Server" })).getAllByRole("menuitem").map((item) => item.textContent?.replace(/\.\.\.$/, ""));
    await user.keyboard("{Escape}");
    // Signed out, only Owner login is available; administrator commands are grayed out.
    await user.click(serverTrigger);
    const serverMenu = within(screen.getByRole("menu", { name: "Server" }));
    expect((serverMenu.getByRole("menuitem", { name: "Owner login..." }) as HTMLButtonElement).disabled).toBe(false);
    for (const name of ["Integrations...", "Rooms & repositories...", "Diagnostics..."]) expect((serverMenu.getByRole("menuitem", { name }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    await chooseMenuItem(user, "Server", "Owner login...");
    const administration = screen.getByRole("dialog", { name: "Server Administration" });
    // Each Server command is named exactly like the window page it opens.
    expect(serverCommands).toEqual(within(administration).getAllByRole("tab").map((tab) => tab.querySelector(":scope > span:not([aria-hidden])")?.textContent));
    expect(within(administration).getByRole("tab", { name: "Owner login" }).getAttribute("aria-selected")).toBe("true");
    expect(await within(administration).findByRole("heading", { name: "Owner login" })).toBeTruthy();
    // Signed out, other pages open as previews with every control disabled.
    await user.click(within(administration).getByRole("tab", { name: "Integrations" }));
    expect(within(administration).getByText(/Preview only/)).toBeTruthy();
    expect((within(administration).getByRole("button", { name: "Connect GitHub" }) as HTMLButtonElement).matches(":disabled")).toBe(true);
    expect((within(administration).getByRole("button", { name: "Refresh" }) as HTMLButtonElement).matches(":disabled")).toBe(true);
    // The chat window stays in place behind the administration window.
    expect(screen.getByRole("log", { name: "Room transcript" })).toBeTruthy();
    await user.click(within(administration).getByRole("button", { name: "Close server administration" }));
    expect(screen.queryByRole("dialog", { name: "Server Administration" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(serverTrigger));
    expect(pushState).not.toHaveBeenCalled();
  });

  it("previews Diagnostics disabled until owner login and signs out without leaving the room", async () => {
    let authenticated = false;
    const session = { principal: { id: "durable-owner", username: "server-owner", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "fictional-control-csrf", expiresAt: new Date(Date.now() + 28_800_000).toISOString() };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path === "/api/control/status") return Response.json({ claimed: true, bootstrapConfigured: true });
      if (path === "/api/control/me") return authenticated ? Response.json(session) : Response.json({ error: "Sign in required" }, { status: 401 });
      if (path === "/api/control/login") { authenticated = true; return Response.json(session); }
      if (path === "/api/control/logout") { authenticated = false; return new Response(null, { status: 204 }); }
      if (path === "/api/control/diagnostics/query") return authenticated ? Response.json({ records: [], chunks: [], nextCursor: null, scannedBytes: 0, serializedBytes: 0, malformedRecords: 0, scanLimitReached: false }) : Response.json({ error: "Unavailable" }, { status: 403 });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    await renderConnected();
    const savedIdentity = window.localStorage.getItem("all-my-friends-are-agents-human");
    await chooseMenuItem(user, "Server", "Owner login...");
    await user.click(screen.getByRole("tab", { name: "Diagnostics" }));
    expect((await screen.findByRole("button", { name: "Query diagnostics" }) as HTMLButtonElement).matches(":disabled")).toBe(true);
    await user.click(screen.getByRole("tab", { name: "Owner login" }));
    await user.type(await screen.findByLabelText("Username"), "server-owner");
    await user.type(screen.getByLabelText("Password"), "fictional-password{enter}");
    await screen.findByRole("button", { name: "Sign out" });
    await user.click(screen.getByRole("tab", { name: "Diagnostics" }));
    await screen.findByRole("heading", { name: "Owner diagnostics" });
    expect(screen.queryByText(/Preview only/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Query diagnostics" }));
    await screen.findByText("No matching records.");
    await user.click(screen.getByRole("tab", { name: "Owner login" }));
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Sign in" });
    expect(window.localStorage.getItem("all-my-friends-are-agents-human")).toBe(savedIdentity);
    await user.click(screen.getByRole("button", { name: "Close server administration" }));
    expect(screen.queryByRole("dialog", { name: "Server Administration" })).toBeNull();
    expect(api.joinRoom).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe("/");
  });

  it("toggles and persists visual timestamps from the View menu", async () => {
    const user = userEvent.setup();
    await renderConnected([{ id: "timed", speaker: "you", text: "Timestamped", timestamp: "2026-08-24T12:00:00.000Z" }]);

    await user.click(screen.getByRole("menuitem", { name: "View" }));
    expect(within(screen.getByRole("menu", { name: "View" })).getByRole("menuitemcheckbox", { name: "Timestamps" }).getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{Escape}");

    await chooseMenuItem(user, "View", "Timestamps");
    expect(screen.getByRole("log", { name: "Room transcript" }).className).toContain("transcript--timestamps-hidden");
    expect(window.localStorage.getItem(TRANSCRIPT_TIMESTAMPS_STORAGE_KEY)).toBe("false");

    await chooseMenuItem(user, "View", "Timestamps");
    expect(screen.getByRole("log", { name: "Room transcript" }).className).not.toContain("transcript--timestamps-hidden");
    expect(window.localStorage.getItem(TRANSCRIPT_TIMESTAMPS_STORAGE_KEY)).toBe("true");
  });

  it("toggles and persists message prices from the View menu", async () => {
    const user = userEvent.setup();
    await renderConnected([{ id: "priced", speaker: "codex-sol", text: "Priced", timestamp: "2026-08-24T12:00:00.000Z", openRouterCostUsd: 0.0042 }]);

    await user.click(screen.getByRole("menuitem", { name: "View" }));
    expect(within(screen.getByRole("menu", { name: "View" })).getByRole("menuitemcheckbox", { name: "Message prices" }).getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{Escape}");

    await chooseMenuItem(user, "View", "Message prices");
    expect(screen.getByRole("log", { name: "Room transcript" }).className).toContain("transcript--prices-hidden");
    expect(window.localStorage.getItem(TRANSCRIPT_MESSAGE_PRICES_STORAGE_KEY)).toBe("false");

    await chooseMenuItem(user, "View", "Message prices");
    expect(screen.getByRole("log", { name: "Room transcript" }).className).not.toContain("transcript--prices-hidden");
    expect(window.localStorage.getItem(TRANSCRIPT_MESSAGE_PRICES_STORAGE_KEY)).toBe("true");
  });

  it("toggles and persists system activity from the View menu", async () => {
    const user = userEvent.setup();
    await renderConnected([{ id: "activity", speaker: "system", kind: "status", text: "Sol considered the message but did not reply to the chat.", timestamp: "2026-08-24T12:00:00.000Z" }]);

    await user.click(screen.getByRole("menuitem", { name: "View" }));
    expect(within(screen.getByRole("menu", { name: "View" })).getByRole("menuitemcheckbox", { name: "System activity" }).getAttribute("aria-checked")).toBe("true");
    await user.keyboard("{Escape}");

    await chooseMenuItem(user, "View", "System activity");
    expect(screen.queryByText("Sol considered the message but did not reply to the chat.")).toBeNull();
    expect(window.localStorage.getItem(TRANSCRIPT_SYSTEM_ACTIVITY_STORAGE_KEY)).toBe("false");

    await chooseMenuItem(user, "View", "System activity");
    expect(screen.getByText("Sol considered the message but did not reply to the chat.")).toBeTruthy();
    expect(window.localStorage.getItem(TRANSCRIPT_SYSTEM_ACTIVITY_STORAGE_KEY)).toBe("true");
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
    const originalClientId = requiredAt(api.sendMessage.mock.calls, 0, "initial send-message call")[1];
    expect(originalClientId).toMatch(/^message_/);

    act(() => eventSourceAt(0).fail());
    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(2), { timeout: 2_000 });
    expect((screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement).disabled).toBe(true);

    act(() => eventSourceAt(1).emit(room("server-after")));
    await waitFor(() => expect((screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement).disabled).toBe(false));
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Not sent — send now\?/)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    expect(requiredAt(api.sendMessage.mock.calls, 1, "retry send-message call")).toEqual(["Did this land?", originalClientId, []]);
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

    act(() => eventSourceAt(0).fail());
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Keep this draft");
    await waitFor(() => expect(loadDraftSnapshot(window.localStorage, human.id).text).toBe("Keep this draft"));
    expect(screen.getByText("Before outage")).not.toBeNull();

    await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(2), { timeout: 2_000 });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Keep this draft");

    act(() => eventSourceAt(1).emit(room("server-after", [before, during])));
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

  it("dismisses only the local server-error notice and shows a later occurrence again", async () => {
    const user = userEvent.setup();
    await renderConnected();
    const source = eventSourceAt(0);
    const { messages: _messages, ...clearState } = room("notice");
    const state = { ...clearState, error: "Room action failed" };
    act(() => source.emitEvent({ kind: "state-delta", streamId: "stream-1", fromVersion: 0, version: 1, state }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Room action failed"));
    await user.click(await screen.findByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => source.emitEvent({ kind: "state-delta", streamId: "stream-1", fromVersion: 1, version: 2, state: clearState }));
    act(() => source.emitEvent({ kind: "state-delta", streamId: "stream-1", fromVersion: 2, version: 3, state }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Room action failed"));
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

});

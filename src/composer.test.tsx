// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef, Profiler } from "react";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { ComposerBoundary, DRAFT_PERSISTENCE_DELAY_MS } from "./composer";
import { loadDraftSnapshot } from "./client-persistence";
import { Transcript } from "./components";

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

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ComposerBoundary", () => {
  it("keeps transcript commits out of the keystroke path", async () => {
    const transcriptCommits = vi.fn();
    const user = userEvent.setup();
    render(<>
      <Profiler id="transcript" onRender={transcriptCommits}>
        <Transcript
          messages={[{ id: "history", speaker: "you", text: "Existing history", timestamp: "2026-08-21T12:00:00Z" }]}
          magnification={100}
          transcriptRef={createRef<HTMLDivElement>()}
        />
      </Profiler>
      <ComposerBoundary
        humanId="alice"
        mentionCandidates={[]}
        style={DEFAULT_PARTICIPANT_STYLES.you}
        onStyleChange={() => undefined}
        onSubmit={vi.fn(async () => ({ restoreOnFailure: false }))}
      />
    </>);
    expect(transcriptCommits).toHaveBeenCalledTimes(1);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "typing stays local");
    expect(transcriptCommits).toHaveBeenCalledTimes(1);
  });

  it("defers persistence to a bounded window and flushes on blur and pagehide", () => {
    vi.useFakeTimers();
    render(<ComposerBoundary
      humanId="alice"
      mentionCandidates={[]}
      style={DEFAULT_PARTICIPANT_STYLES.you}
      onStyleChange={() => undefined}
      onSubmit={vi.fn(async () => ({ restoreOnFailure: false }))}
    />);
    const message = screen.getByRole("textbox", { name: "Message" });

    fireEvent.change(message, { target: { value: "bounded draft" } });
    expect(loadDraftSnapshot(window.localStorage, "alice").text).toBe("");
    act(() => vi.advanceTimersByTime(DRAFT_PERSISTENCE_DELAY_MS - 1));
    expect(loadDraftSnapshot(window.localStorage, "alice").text).toBe("");
    act(() => vi.advanceTimersByTime(1));
    expect(loadDraftSnapshot(window.localStorage, "alice").text).toBe("bounded draft");

    fireEvent.change(message, { target: { value: "blur flush" } });
    fireEvent.blur(message);
    expect(loadDraftSnapshot(window.localStorage, "alice").text).toBe("blur flush");

    fireEvent.change(message, { target: { value: "pagehide flush" } });
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(loadDraftSnapshot(window.localStorage, "alice").text).toBe("pagehide flush");
  });

  it("hands one immutable snapshot to submit and restores it after a definite failure", async () => {
    let resolveSubmit!: (result: { restoreOnFailure: boolean }) => void;
    const onSubmit = vi.fn(() => new Promise<{ restoreOnFailure: boolean }>((resolve) => { resolveSubmit = resolve; }));
    const user = userEvent.setup();
    render(<ComposerBoundary
      humanId="alice"
      mentionCandidates={[]}
      style={DEFAULT_PARTICIPANT_STYLES.you}
      onStyleChange={() => undefined}
      onSubmit={onSubmit}
    />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await user.type(message, "send once");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledWith({ text: "send once", mentions: [] });
    expect(message.value).toBe("");

    await act(async () => resolveSubmit({ restoreOnFailure: true }));
    expect(message.value).toBe("send once");
    expect(loadDraftSnapshot(window.localStorage, "alice").text).toBe("send once");
  });

  it("does not overwrite a new draft when an earlier submit fails", async () => {
    let resolveSubmit!: (result: { restoreOnFailure: boolean }) => void;
    const user = userEvent.setup();
    render(<ComposerBoundary
      humanId="alice"
      mentionCandidates={[]}
      style={DEFAULT_PARTICIPANT_STYLES.you}
      onStyleChange={() => undefined}
      onSubmit={() => new Promise((resolve) => { resolveSubmit = resolve; })}
    />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await user.type(message, "first");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(message, "new draft");
    await act(async () => resolveSubmit({ restoreOnFailure: true }));
    expect(message.value).toBe("new draft");
  });

  it("does not restore an older failure over a later submitted draft", async () => {
    const resolvers: Array<(result: { restoreOnFailure: boolean }) => void> = [];
    const onSubmit = vi.fn(() => new Promise<{ restoreOnFailure: boolean }>((resolve) => { resolvers.push(resolve); }));
    const user = userEvent.setup();
    render(<ComposerBoundary
      humanId="alice"
      mentionCandidates={[]}
      style={DEFAULT_PARTICIPANT_STYLES.you}
      onStyleChange={() => undefined}
      onSubmit={onSubmit}
    />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await user.type(message, "first");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(message, "second");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await act(async () => resolvers[0]({ restoreOnFailure: true }));
    expect(message.value).toBe("");
    await act(async () => resolvers[1]({ restoreOnFailure: false }));
    expect(message.value).toBe("");
  });

  it("restores the draft when a submit handler unexpectedly rejects", async () => {
    const user = userEvent.setup();
    render(<ComposerBoundary
      humanId="alice"
      mentionCandidates={[]}
      style={DEFAULT_PARTICIPANT_STYLES.you}
      onStyleChange={() => undefined}
      onSubmit={() => Promise.reject(new Error("unexpected"))}
    />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await user.type(message, "restore me");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => undefined);
    expect(message.value).toBe("restore me");
  });

  it("starts a fresh session when the human identity changes", async () => {
    const user = userEvent.setup();
    const props = {
      mentionCandidates: [],
      style: DEFAULT_PARTICIPANT_STYLES.you,
      onStyleChange: () => undefined,
      onSubmit: vi.fn(async () => ({ restoreOnFailure: false })),
    };
    const view = render(<ComposerBoundary humanId="alice" {...props} />);
    const aliceMessage = screen.getByRole("textbox", { name: "Message" });
    await user.type(aliceMessage, "Alice draft");
    fireEvent.blur(aliceMessage);

    view.rerender(<ComposerBoundary humanId="bob" {...props} />);
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("");
    expect(loadDraftSnapshot(window.localStorage, "alice").text).toBe("Alice draft");
  });

  it("does not submit while an IME composition is active", () => {
    const onSubmit = vi.fn(async () => ({ restoreOnFailure: false }));
    render(<ComposerBoundary
      humanId="alice"
      mentionCandidates={[]}
      style={DEFAULT_PARTICIPANT_STYLES.you}
      onStyleChange={() => undefined}
      onSubmit={onSubmit}
    />);
    const message = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(message, { target: { value: "構成中" } });
    fireEvent.keyDown(message, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

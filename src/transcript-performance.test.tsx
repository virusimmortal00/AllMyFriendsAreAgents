// @vitest-environment jsdom
import { Profiler, createRef, type ProfilerOnRenderCallback } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "./components";
import type { RoomMessage } from "./types";

// One prop commit plus at most one anchoring-state commit. Existing rows must
// remain untouched regardless of transcript or incoming-message length.
const MAX_TRANSCRIPT_COMMITS_PER_APPEND = 2;
const MAX_EXISTING_MESSAGE_REPLACEMENTS_PER_APPEND = 0;

function message(id: string, text = `Message ${id}`): RoomMessage {
  return { id, speaker: "codex-sol", text, timestamp: "2026-08-24T12:00:00.000Z" };
}

let resizeCallbacks: ResizeObserverCallback[];

class TestResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("measured transcript anchoring", () => {
  it("follows viewport and late content resizing only while the reader remains near the true bottom", async () => {
    const transcriptRef = createRef<HTMLDivElement>();
    const scrollTo = vi.fn(function (this: HTMLDivElement, options: ScrollToOptions) {
      this.scrollTop = Math.max(0, Number(options.top) - this.clientHeight);
    });
    let scrollHeight = 1_000;
    let clientHeight = 300;
    let scrollTop = 700;
    const { rerender } = render(<Transcript messages={[message("one")]} magnification={100} transcriptRef={transcriptRef} />);
    const transcript = transcriptRef.current!;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
      scrollTo: { configurable: true, value: scrollTo },
    });
    scrollTo.mockClear();

    scrollTop = 450;
    transcript.dispatchEvent(new Event("scroll"));
    rerender(<Transcript messages={[message("one"), message("two")]} magnification={100} transcriptRef={transcriptRef} />);

    expect(scrollTo).not.toHaveBeenCalled();
    const affordance = screen.getByRole("button", { name: "New messages ↓" });
    affordance.focus();
    expect(document.activeElement).toBe(affordance);
    act(() => affordance.click());
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1_000, behavior: "smooth" });
    expect(scrollTop).toBe(700);

    scrollHeight = 1_400;
    clientHeight = 220;
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1_400, behavior: "auto" });
    expect(scrollTop).toBe(1_180);
    expect(screen.queryByRole("button", { name: "New messages ↓" })).toBeNull();
  });
});

describe("transcript render budget", () => {
  it("appends one very long message within the documented deterministic DOM budget", () => {
    const initialMessages = Array.from({ length: 160 }, (_, index) => message(`history-${index}`, "x".repeat(2_000)));
    const transcriptRef = createRef<HTMLDivElement>();
    let transcriptCommits = 0;
    const onRender: ProfilerOnRenderCallback = () => { transcriptCommits += 1; };
    const { container, rerender } = render(
      <Profiler id="long-transcript" onRender={onRender}>
        <Transcript messages={initialMessages} magnification={100} transcriptRef={transcriptRef} />
      </Profiler>,
    );
    const existingArticles = [...container.querySelectorAll("article")];
    const commitsBeforeAppend = transcriptCommits;

    rerender(
      <Profiler id="long-transcript" onRender={onRender}>
        <Transcript messages={[...initialMessages, message("late-long-message", "late ".repeat(20_000))]} magnification={100} transcriptRef={transcriptRef} />
      </Profiler>,
    );

    const articlesAfterAppend = [...container.querySelectorAll("article")];
    const replacements = existingArticles.filter((article, index) => article !== articlesAfterAppend[index]).length;
    expect(transcriptCommits - commitsBeforeAppend).toBeLessThanOrEqual(MAX_TRANSCRIPT_COMMITS_PER_APPEND);
    expect(replacements).toBeLessThanOrEqual(MAX_EXISTING_MESSAGE_REPLACEMENTS_PER_APPEND);
    expect(articlesAfterAppend).toHaveLength(initialMessages.length + 1);
  });
});

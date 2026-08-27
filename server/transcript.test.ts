import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { transcriptFor } from "./transcript.js";
import type { RoomMessage, RoomState } from "./types.js";

function state(messages: RoomMessage[]): RoomState {
  return {
    messages,
    sessions: {},
    settings: {
      roomName: "The Agent Room",
      topic: "Open conversation",
      writableAgent: "nobody",
      conversationEnergy: "balanced",
      projectPath: "/tmp",
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status: "idle",
  };
}

describe("agent transcript context", () => {
  it("groups consecutive chunks from one logical burst", () => {
    const messages: RoomMessage[] = [
      { id: "1", speaker: "codex-sol", text: "yeah, a little", timestamp: "2026-08-19T12:00:00Z", burstId: "burst", sequence: 0 },
      { id: "2", speaker: "codex-sol", text: "mostly because of the sidebar", timestamp: "2026-08-19T12:00:01Z", burstId: "burst", sequence: 1 },
      { id: "3", speaker: "codex-sol", text: "I'd simplify that first", timestamp: "2026-08-19T12:00:02Z", burstId: "burst", sequence: 2 },
    ];

    const transcript = transcriptFor(state(messages));
    expect(transcript.match(/\[SOL\]/g)).toHaveLength(1);
    expect(transcript).toContain("yeah, a little\nmostly because of the sidebar\nI'd simplify that first");
  });

  it("uses a character budget instead of dropping everything before the last 24 messages", () => {
    const messages = Array.from({ length: 30 }, (_, index): RoomMessage => ({
      id: String(index), speaker: "you", text: `message ${index}`, timestamp: "2026-08-19T12:00:00Z",
    }));

    const transcript = transcriptFor(state(messages), 4_000);
    expect(transcript).toContain("message 0");
    expect(transcript).toContain("message 29");
    expect(transcript.length).toBeLessThanOrEqual(4_000);
  });

  it("excludes agent workflow narration without altering the same words from a human", () => {
    const preface = "This is not a coding task, so plan mode and the planning workflow do not apply.";
    const transcript = transcriptFor(state([
      { id: "1", speaker: "you", text: `${preface}\n\nWhat game wins?`, timestamp: "2026-08-19T12:00:00Z" },
      { id: "2", speaker: "claude-sonnet", text: `${preface}\n\nSolitaire, unironically.`, timestamp: "2026-08-19T12:00:01Z" },
    ]));

    expect(transcript).toContain(`[YOU]\n${preface}\n\nWhat game wins?`);
    expect(transcript).toContain("[CLAUDE]\nSolitaire, unironically.");
    expect(transcript.match(/plan mode/g)).toHaveLength(1);
  });

  it("keeps different human names distinct in agent context", () => {
    const transcript = transcriptFor(state([
      { id: "1", speaker: "you", humanId: "alice-id", speakerName: "Alice", text: "I prefer blue.", timestamp: "2026-08-19T12:00:00Z" },
      { id: "2", speaker: "you", humanId: "bob-id", speakerName: "Bob", text: "I prefer orange.", timestamp: "2026-08-19T12:00:01Z" },
    ]));

    expect(transcript).toContain("[ALICE]\nI prefer blue.");
    expect(transcript).toContain("[BOB]\nI prefer orange.");
  });

  it("keeps legacy orchestration instructions out of future agent context", () => {
    const transcript = transcriptFor(state([
      { id: "1", speaker: "system", kind: "status", text: "The discussion remains open. Use Actions → Continue discussion to start another bounded round.", timestamp: "2026-08-19T12:00:00Z" },
      { id: "provider", speaker: "system", kind: "status", text: "Claude [Claude Sonnet 5] is unavailable: Provider usage limit reached. Other agents will keep going.", timestamp: "2026-08-19T12:00:00.500Z" },
      { id: "2", speaker: "you", text: "Let's talk normally.", timestamp: "2026-08-19T12:00:01Z" },
    ]));

    expect(transcript).not.toContain("Use Actions");
    expect(transcript).not.toContain("Provider usage limit");
    expect(transcript).toContain("Let's talk normally.");
  });

  it("keeps an up-to-date agent prompt independent of transcript length", async () => {
    const scoped = (messages: RoomMessage[], cursor: string): RoomState => ({
      ...state(messages),
      roster: { schemaVersion: 3, revision: 4, entries: [{ agentId: "codex-sol", conversationalName: "Sol", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, lastSeenMessageId: cursor }] },
    });
    const shortMessages = [{ id: "short", speaker: "you" as const, text: "latest", timestamp: "2026-08-19T12:00:00Z" }];
    const longMessages = Array.from({ length: 500 }, (_, index): RoomMessage => ({ id: `long-${index}`, speaker: "you", text: `history ${index}`, timestamp: "2026-08-19T12:00:00Z" }));
    const short = await transcriptFor(scoped(shortMessages, "short"), { agentId: "codex-sol" });
    const long = await transcriptFor(scoped(longMessages, "long-499"), { agentId: "codex-sol" });
    expect(short.mode).toBe("delta");
    expect(long.mode).toBe("delta");
    expect(long.text.length).toBe(short.text.length);
    expect(long.text).not.toContain("history 0");
  });

  it("uses summaries only above the delta threshold and caches cold-start spans", async () => {
    const messages = [
      { id: "topic", speaker: "system" as const, kind: "topic" as const, text: "Room topic: Test", timestamp: "2026-08-19T12:00:00Z" },
      ...Array.from({ length: 21 }, (_, index): RoomMessage => ({ id: `message-${index}`, speaker: "you", text: `verbatim ${index}`, timestamp: "2026-08-19T12:00:00Z" })),
    ];
    const room: RoomState = {
      ...state(messages),
      roster: { schemaVersion: 3, revision: 1, entries: [{ agentId: "codex-sol", conversationalName: "Sol", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, lastSeenMessageId: "topic" }] },
    };
    const cache = new Map<string, string>();
    const summaryStore = {
      async getAgentContextSummary(key: { agentId: string; spanStartId: string; spanEndId: string }) { return cache.get(JSON.stringify(key)); },
      async putAgentContextSummary(key: { agentId: string; spanStartId: string; spanEndId: string }, summary: string) { cache.set(JSON.stringify(key), summary); },
    };
    const summarize = vi.fn(async () => "A cached bounded summary.");
    const first = await transcriptFor(room, { agentId: "codex-sol", summaryStore, summarizer: { summarize } });
    const second = await transcriptFor(room, { agentId: "codex-sol", summaryStore, summarizer: { summarize } });
    expect(first.mode).toBe("summary");
    expect(first.text).toContain("A cached bounded summary.");
    expect(first.text).toContain("verbatim 20");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(second.text).toBe(first.text);
  });

  it("regenerates a cold-start summary when the summarizer configuration revision changes", async () => {
    const messages = Array.from({ length: 24 }, (_, index): RoomMessage => ({ id: `revision-${index}`, speaker: "you", text: `message ${index}`, timestamp: "2026-08-19T12:00:00Z" }));
    const room: RoomState = { ...state(messages), roster: { schemaVersion: 3, revision: 1, entries: [{ agentId: "codex-sol", conversationalName: "Sol", modelId: "gpt-5.6-sol", enabled: true }] } };
    const cache = new Map<string, string>();
    const summaryStore = {
      async getAgentContextSummary(key: object) { return cache.get(JSON.stringify(key)); },
      async putAgentContextSummary(key: object, summary: string) { cache.set(JSON.stringify(key), summary); },
    };
    const summarize = vi.fn(async () => "Revision-sensitive summary.");
    const configuration = { basePromptRevision: 0, basePromptText: "default", summarizerModel: null, summarizerPromptText: "{{transcript}}", featureFlags: {}, updatedAt: null };
    await transcriptFor({ ...room, roomConfiguration: { ...configuration, summarizerPromptRevision: 1 } }, { agentId: "codex-sol", summaryStore, summarizer: { summarize } });
    await transcriptFor({ ...room, roomConfiguration: { ...configuration, summarizerPromptRevision: 2 } }, { agentId: "codex-sol", summaryStore, summarizer: { summarize } });
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("falls back to the full verbatim delta when summarization fails", async () => {
    const messages = [
      { id: "cursor", speaker: "you" as const, text: "seen", timestamp: "2026-08-19T12:00:00Z" },
      ...Array.from({ length: 21 }, (_, index): RoomMessage => ({ id: `delta-${index}`, speaker: "you", text: `exact ${index}`, timestamp: "2026-08-19T12:00:00Z" })),
    ];
    const room: RoomState = {
      ...state(messages),
      roster: { schemaVersion: 3, revision: 1, entries: [{ agentId: "codex-sol", conversationalName: "Sol", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, lastSeenMessageId: "cursor" }] },
    };
    const transcript = await transcriptFor(room, {
      agentId: "codex-sol",
      summaryStore: { async getAgentContextSummary() { return undefined; }, async putAgentContextSummary() {} },
      summarizer: { async summarize() { throw new Error("provider unavailable"); } },
    });
    expect(transcript.mode).toBe("verbatim-fallback");
    expect(transcript.text).toContain("[YOU | delta-0]\nexact 0");
    expect(transcript.text).toContain("[YOU | delta-20]\nexact 20");
  });

  it("does not block or inject an oversized transcript while a large cold-start summary is pending", async () => {
    vi.useFakeTimers();
    try {
      const messages = Array.from({ length: 40 }, (_, index): RoomMessage => ({ id: `large-${index}`, speaker: "you", text: `exact ${index} ${"x".repeat(2_000)}`, timestamp: "2026-08-19T12:00:00Z" }));
      const room: RoomState = { ...state(messages), roster: { schemaVersion: 3, revision: 1, entries: [{ agentId: "codex-sol", conversationalName: "Sol", modelId: "gpt-5.6-sol", enabled: true }] } };
      const pending = new Promise<string>(() => undefined);
      const transcriptPromise = transcriptFor(room, {
        agentId: "codex-sol",
        summaryStore: { async getAgentContextSummary() { return undefined; }, async putAgentContextSummary() {} },
        summarizer: { summarize: () => pending },
      });
      await vi.advanceTimersByTimeAsync(751);
      const transcript = await transcriptPromise;
      expect(transcript.mode).toBe("summary");
      expect(transcript.text).toContain("SUMMARY PENDING");
      expect(transcript.text).toContain("still being prepared without blocking this turn");
      expect(transcript.text.length).toBeLessThan(48_000);
      expect(transcript.text).not.toContain("exact 0");
      expect(transcript.text).toContain("exact 39");
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { parseAgentTurn, roomMessageTurns, runAgentConversation, type ConversationTurn, type TurnResult } from "./conversation.js";
import type { AgentId } from "./types.js";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";

describe("agent turn parsing", () => {
  it("removes disposition metadata and recognizes a mention of the other agent", () => {
    expect(parseAgentTurn("codex", "Claude, what do you think?\n\nDISPOSITION: PROPOSAL")).toEqual({
      visibleMessages: ["Claude, what do you think?"],
      replyCandidate: "claude",
      mentionedAgent: "claude",
    });
  });

  it("suppresses a no-response decision", () => {
    expect(parseAgentTurn("claude", "NO_RESPONSE_NEEDED")).toEqual({
      visibleMessages: [],
      replyCandidate: undefined,
      mentionedAgent: undefined,
    });
  });

  it("extracts and validates an agent's private style directive", () => {
    expect(parseAgentTurn(
      "claude",
      "A useful answer.\nSTYLE: {\"fontFamily\":\"Comic Sans MS\",\"fontSize\":22,\"textColor\":\"#ED36FF\",\"backgroundColor\":\"#ECECEC\",\"bold\":true,\"italic\":false,\"underline\":false}",
      DEFAULT_PARTICIPANT_STYLES.claude,
    )).toEqual({
      visibleMessages: ["A useful answer."],
      replyCandidate: "codex",
      mentionedAgent: undefined,
      styleUpdate: {
        fontFamily: "Comic Sans MS",
        fontSize: 22,
        textColor: "#ed36ff",
        backgroundColor: "#ececec",
        bold: true,
        italic: false,
        underline: false,
      },
    });
  });

  it("splits only explicit burst separators, removes empty units, and caps the burst at three", () => {
    expect(parseAgentTurn(
      "codex",
      "First paragraph. Still one message.\n\n<<<NEXT>>>\n\n\n<<<NEXT>>>\nSecond message.\n<<<NEXT>>>\nThird message.\n<<<NEXT>>>\nDiscarded fourth.",
    ).visibleMessages).toEqual([
      "First paragraph. Still one message.",
      "Second message.",
      "Third message.",
    ]);
  });

  it("keeps private style directives out of every visible burst unit", () => {
    expect(parseAgentTurn(
      "claude",
      "First\n<<<NEXT>>>\nSecond\nSTYLE: {\"fontFamily\":\"Verdana\",\"fontSize\":18}",
      DEFAULT_PARTICIPANT_STYLES.claude,
    )).toMatchObject({
      visibleMessages: ["First", "Second"],
      styleUpdate: { fontFamily: "Verdana", fontSize: 18 },
    });
  });

  it("removes unsupported Unicode emoji while preserving classic AIM shortcuts", () => {
    expect(parseAgentTurn(
      "codex",
      "road trip 🤘🚙🛠️ :-)\n<<<NEXT>>>\n🇺🇸 1️⃣",
    )).toMatchObject({
      visibleMessages: ["road trip :-)"],
      replyCandidate: "claude",
    });
  });
});

describe("agent conversations", () => {
  it("lets an agent start another turn after the other agent mentions them", async () => {
    const responses = [
      { mentionedAgent: "claude" as const },
      { mentionedAgent: "codex" as const },
      {},
    ];
    const seenAgents: AgentId[] = [];
    const performTurn = vi.fn(async (turn: ConversationTurn) => {
      seenAgents.push(turn.agent);
      return responses.shift() || {};
    });

    await runAgentConversation(
      [{ agent: "codex", instruction: "Respond to the human." }],
      3,
      performTurn,
    );

    expect(seenAgents).toEqual(["codex", "claude", "codex"]);
  });

  it("defers a direct mention when the named agent already has a pending turn", async () => {
    const performTurn = vi
      .fn()
      .mockResolvedValueOnce({ mentionedAgent: "claude" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await runAgentConversation(
      [
        { agent: "codex", instruction: "Respond to the human." },
        { agent: "claude", instruction: "Respond to the human." },
      ],
      3,
      performTurn,
    );

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex", "claude", "claude"]);
  });

  it("caps automatic follow-ups", async () => {
    const seenAgents: AgentId[] = [];
    const performTurn = vi.fn(async ({ agent }: ConversationTurn): Promise<TurnResult> => {
      seenAgents.push(agent);
      return { mentionedAgent: agent === "codex" ? "claude" : "codex" };
    });

    await runAgentConversation(
      [{ agent: "codex", instruction: "Start." }],
      2,
      performTurn,
    );

    expect(seenAgents).toEqual(["codex", "claude", "codex"]);
  });

  it("starts initial agents concurrently and schedules reactions from completion order", async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((next) => { resolve = next; });
      return { promise, resolve };
    }

    const codexInitial = deferred<TurnResult>();
    const claudeInitial = deferred<TurnResult>();
    const claudeReaction = deferred<TurnResult>();
    const seenAgents: AgentId[] = [];
    let claudeTurns = 0;
    const performTurn = vi.fn((turn: ConversationTurn) => {
      seenAgents.push(turn.agent);
      if (turn.agent === "codex") return codexInitial.promise;
      claudeTurns += 1;
      return claudeTurns === 1 ? claudeInitial.promise : claudeReaction.promise;
    });

    const conversation = runAgentConversation(roomMessageTurns(), 1, performTurn);
    await vi.waitFor(() => expect(seenAgents).toEqual(["codex", "claude"]));

    claudeInitial.resolve({ replyCandidate: "codex" });
    await Promise.resolve();
    expect(performTurn).toHaveBeenCalledTimes(2);

    codexInitial.resolve({ replyCandidate: "claude" });
    await vi.waitFor(() => expect(seenAgents).toEqual(["codex", "claude", "claude"]));
    claudeReaction.resolve({});
    await conversation;
  });
});

describe("room message policy", () => {
  it("sends every normal room message to both agents", () => {
    expect(new Set(roomMessageTurns().map(({ agent }) => agent))).toEqual(new Set(["codex", "claude"]));
  });
});

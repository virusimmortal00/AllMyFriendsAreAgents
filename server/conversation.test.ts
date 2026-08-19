import { describe, expect, it, vi } from "vitest";
import { parseAgentTurn, roomMessageTurns, runAgentConversation, type ConversationTurn, type TurnResult } from "./conversation.js";
import type { AgentId } from "./types.js";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";

describe("agent turn parsing", () => {
  it("removes disposition metadata and recognizes a mention of the other agent", () => {
    expect(parseAgentTurn("codex-sol", "Claude, what do you think?\n\nDISPOSITION: PROPOSAL")).toEqual({
      visibleMessages: ["Claude, what do you think?"],
      replyCandidates: ["codex-luna", "codex-terra", "claude-sonnet"],
      mentionedAgents: ["claude-sonnet"],
    });
  });

  it("suppresses a no-response decision", () => {
    expect(parseAgentTurn("claude-sonnet", "NO_RESPONSE_NEEDED")).toEqual({
      visibleMessages: [],
      replyCandidates: [],
      mentionedAgents: [],
    });
  });

  it("extracts and validates an agent's private style directive", () => {
    expect(parseAgentTurn(
      "claude-sonnet",
      "A useful answer.\nSTYLE: {\"fontFamily\":\"Comic Sans MS\",\"fontSize\":22,\"textColor\":\"#ED36FF\",\"backgroundColor\":\"#ECECEC\",\"bold\":true,\"italic\":false,\"underline\":false}",
      DEFAULT_PARTICIPANT_STYLES["claude-sonnet"],
    )).toEqual({
      visibleMessages: ["A useful answer."],
      replyCandidates: ["codex-luna", "codex-terra", "codex-sol"],
      mentionedAgents: [],
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
      "codex-sol",
      "First paragraph. Still one message.\n\n<<<NEXT>>>\n\n\n<<<NEXT>>>\nSecond message.\n<<<NEXT>>>\nThird message.\n<<<NEXT>>>\nDiscarded fourth.",
    ).visibleMessages).toEqual([
      "First paragraph. Still one message.",
      "Second message.",
      "Third message.",
    ]);
  });

  it("keeps private style directives out of every visible burst unit", () => {
    expect(parseAgentTurn(
      "claude-sonnet",
      "First\n<<<NEXT>>>\nSecond\nSTYLE: {\"fontFamily\":\"Verdana\",\"fontSize\":18}",
      DEFAULT_PARTICIPANT_STYLES["claude-sonnet"],
    )).toMatchObject({
      visibleMessages: ["First", "Second"],
      styleUpdate: { fontFamily: "Verdana", fontSize: 18 },
    });
  });

  it("removes unsupported Unicode emoji while preserving classic AIM shortcuts", () => {
    expect(parseAgentTurn(
      "codex-sol",
      "road trip 🤘🚙🛠️ :-)\n<<<NEXT>>>\n🇺🇸 1️⃣",
    )).toMatchObject({
      visibleMessages: ["road trip :-)"],
      replyCandidates: ["codex-luna", "codex-terra", "claude-sonnet"],
    });
  });

  it("removes leading internal workflow narration from visible agent output", () => {
    expect(parseAgentTurn(
      "claude-sonnet",
      "This is casual banter, not a coding task, so plan mode and the planning workflow don't apply.\n\nSolitaire, unironically.",
    ).visibleMessages).toEqual(["Solitaire, unironically."]);
  });
});

describe("agent conversations", () => {
  it("lets an agent start another turn after the other agent mentions them", async () => {
    const responses = [
      { mentionedAgents: ["claude-sonnet" as const] },
      { mentionedAgents: ["codex-sol" as const] },
      {},
    ];
    const seenAgents: AgentId[] = [];
    const performTurn = vi.fn(async (turn: ConversationTurn) => {
      seenAgents.push(turn.agent);
      return responses.shift() || {};
    });

    await runAgentConversation(
      [{ agent: "codex-sol", instruction: "Respond to the human." }],
      3,
      performTurn,
    );

    expect(seenAgents).toEqual(["codex-sol", "claude-sonnet", "codex-sol"]);
  });

  it("defers a direct mention when the named agent already has a pending turn", async () => {
    const performTurn = vi
      .fn()
      .mockResolvedValueOnce({ mentionedAgents: ["claude-sonnet"] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await runAgentConversation(
      [
        { agent: "codex-sol", instruction: "Respond to the human." },
        { agent: "claude-sonnet", instruction: "Respond to the human." },
      ],
      3,
      performTurn,
    );

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-sol", "claude-sonnet", "claude-sonnet"]);
  });

  it("caps automatic follow-ups", async () => {
    const seenAgents: AgentId[] = [];
    const performTurn = vi.fn(async ({ agent }: ConversationTurn): Promise<TurnResult> => {
      seenAgents.push(agent);
      return { mentionedAgents: [agent === "codex-sol" ? "claude-sonnet" : "codex-sol"] };
    });

    await runAgentConversation(
      [{ agent: "codex-sol", instruction: "Start." }],
      2,
      performTurn,
    );

    expect(seenAgents).toEqual(["codex-sol", "claude-sonnet", "codex-sol"]);
  });

  it("starts initial agents concurrently and schedules reactions from completion order", async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((next) => { resolve = next; });
      return { promise, resolve };
    }

    const initial = new Map([
      ["codex-luna", deferred<TurnResult>()],
      ["codex-terra", deferred<TurnResult>()],
      ["codex-sol", deferred<TurnResult>()],
      ["claude-sonnet", deferred<TurnResult>()],
    ] as const);
    const lunaReaction = deferred<TurnResult>();
    const seenAgents: AgentId[] = [];
    const turnCounts = new Map<AgentId, number>();
    const performTurn = vi.fn((turn: ConversationTurn) => {
      seenAgents.push(turn.agent);
      const count = turnCounts.get(turn.agent) || 0;
      turnCounts.set(turn.agent, count + 1);
      return count === 0 ? initial.get(turn.agent)!.promise : lunaReaction.promise;
    });

    const conversation = runAgentConversation(roomMessageTurns(), 1, performTurn);
    await vi.waitFor(() => expect(seenAgents).toEqual(["codex-luna", "codex-terra", "codex-sol", "claude-sonnet"]));

    initial.get("codex-luna")!.resolve({ replyCandidates: ["codex-terra", "codex-sol", "claude-sonnet"] });
    await Promise.resolve();
    expect(performTurn).toHaveBeenCalledTimes(4);

    initial.get("codex-terra")!.resolve({ replyCandidates: ["codex-luna", "codex-sol", "claude-sonnet"] });
    await vi.waitFor(() => expect(seenAgents).toEqual(["codex-luna", "codex-terra", "codex-sol", "claude-sonnet", "codex-luna"]));
    initial.get("codex-sol")!.resolve({});
    initial.get("claude-sonnet")!.resolve({});
    lunaReaction.resolve({});
    await conversation;
  });
});

describe("room message policy", () => {
  it("sends every normal room message to all configured agents", () => {
    expect(new Set(roomMessageTurns().map(({ agent }) => agent))).toEqual(new Set(["codex-luna", "codex-terra", "codex-sol", "claude-sonnet"]));
  });
});

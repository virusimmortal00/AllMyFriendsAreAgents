import { describe, expect, it, vi } from "vitest";
import { parseAgentTurn, roomMessageTurns, runMentionConversation, type ConversationTurn, type TurnResult } from "./conversation.js";
import type { AgentId } from "./types.js";

describe("agent turn parsing", () => {
  it("removes disposition metadata and recognizes a mention of the other agent", () => {
    expect(parseAgentTurn("codex", "Claude, what do you think?\n\nDISPOSITION: PROPOSAL")).toEqual({
      visibleText: "Claude, what do you think?",
      mentionedAgent: "claude",
    });
  });

  it("suppresses a no-response decision", () => {
    expect(parseAgentTurn("claude", "NO_RESPONSE_NEEDED")).toEqual({
      visibleText: "",
      mentionedAgent: undefined,
    });
  });
});

describe("mention-driven conversations", () => {
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

    await runMentionConversation(
      [{ agent: "codex", instruction: "Respond to the human." }],
      3,
      performTurn,
    );

    expect(seenAgents).toEqual(["codex", "claude", "codex"]);
  });

  it("does not duplicate an agent that already has a pending turn", async () => {
    const performTurn = vi
      .fn()
      .mockResolvedValueOnce({ mentionedAgent: "claude" })
      .mockResolvedValueOnce({});

    await runMentionConversation(
      [
        { agent: "codex", instruction: "Respond to the human." },
        { agent: "claude", instruction: "Respond to the human." },
      ],
      3,
      performTurn,
    );

    expect(performTurn).toHaveBeenCalledTimes(2);
  });

  it("caps automatic follow-ups", async () => {
    const seenAgents: AgentId[] = [];
    const performTurn = vi.fn(async ({ agent }: ConversationTurn): Promise<TurnResult> => {
      seenAgents.push(agent);
      return { mentionedAgent: agent === "codex" ? "claude" : "codex" };
    });

    await runMentionConversation(
      [{ agent: "codex", instruction: "Start." }],
      2,
      performTurn,
    );

    expect(seenAgents).toEqual(["codex", "claude", "codex"]);
  });
});

describe("room message policy", () => {
  it("sends every normal room message to both agents", () => {
    expect(roomMessageTurns().map(({ agent }) => agent)).toEqual(["codex", "claude"]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { latestHumanInvitesWholeRoom, parseAgentTurn, rankRoomAgents, roomMessageTurns, runAgentConversation, runEnergyConversation, type ConversationTurn, type TurnResult } from "./conversation.js";
import type { AgentId, RoomMessage, RoomState } from "./types.js";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { AGENT_IDS } from "../shared/participants.js";

function roomState(messages: RoomMessage[]): RoomState {
  return {
    messages,
    sessions: {},
    settings: {
      roomName: "The Agent Room",
      topic: "Open conversation",
      writableAgent: "nobody",
      conversationEnergy: "balanced",
      projectPath: process.cwd(),
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status: "idle",
  };
}

function candidatesForAllAgents(): ConversationTurn[] {
  return AGENT_IDS.map((agent) => ({
    agent,
    instruction: "Consider joining.",
  }));
}

describe("agent turn parsing", () => {
  it("removes disposition metadata and recognizes a mention of the other agent", () => {
    expect(parseAgentTurn("codex-sol", "Claude, what do you think?\n\nDISPOSITION: PROPOSAL")).toEqual({
      visibleMessages: ["Claude, what do you think?"],
      replyCandidates: AGENT_IDS.filter((agent) => agent !== "codex-sol"),
      mentionedAgents: ["claude-sonnet"],
      visibleMessageCount: 1,
      continuationWorthy: true,
    });
  });

  it("keeps the declared conversation state private while returning it to the orchestrator", () => {
    expect(parseAgentTurn("codex-sol", "We should test the migration first.\n\nCONVERSATION_STATE: OPEN")).toMatchObject({
      visibleMessages: ["We should test the migration first."],
      conversationState: "open",
    });
  });

  it("suppresses a no-response decision", () => {
    expect(parseAgentTurn("claude-sonnet", "NO_RESPONSE_NEEDED")).toEqual({
      visibleMessages: [],
      replyCandidates: [],
      mentionedAgents: [],
      visibleMessageCount: 0,
      continuationWorthy: false,
    });
  });

  it("extracts and validates an agent's private style directive", () => {
    expect(parseAgentTurn(
      "claude-sonnet",
      "A useful answer.\nSTYLE: {\"fontFamily\":\"Comic Sans MS\",\"fontSize\":22,\"textColor\":\"#ED36FF\",\"backgroundColor\":\"#ECECEC\",\"bold\":true,\"italic\":false,\"underline\":false}",
      DEFAULT_PARTICIPANT_STYLES["claude-sonnet"],
    )).toEqual({
      visibleMessages: ["A useful answer."],
      replyCandidates: AGENT_IDS.filter((agent) => agent !== "claude-sonnet"),
      mentionedAgents: [],
      visibleMessageCount: 1,
      continuationWorthy: false,
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
      replyCandidates: AGENT_IDS.filter((agent) => agent !== "codex-sol"),
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

    const initial = new Map<AgentId, ReturnType<typeof deferred<TurnResult>>>(
      AGENT_IDS.map((agent) => [agent, deferred<TurnResult>()]),
    );
    const lunaReaction = deferred<TurnResult>();
    const seenAgents: AgentId[] = [];
    const turnCounts = new Map<AgentId, number>();
    const performTurn = vi.fn((turn: ConversationTurn) => {
      seenAgents.push(turn.agent);
      const count = turnCounts.get(turn.agent) || 0;
      turnCounts.set(turn.agent, count + 1);
      return count === 0 ? initial.get(turn.agent)!.promise : lunaReaction.promise;
    });

    const concurrentTurns = candidatesForAllAgents();
    const conversation = runAgentConversation(concurrentTurns, 1, performTurn, AGENT_IDS.length);
    await vi.waitFor(() => expect(seenAgents).toEqual(AGENT_IDS));

    initial.get("codex-terra")!.resolve({ replyCandidates: ["codex-sol", "claude-sonnet", "claude-opus"] });
    await Promise.resolve();
    expect(performTurn).toHaveBeenCalledTimes(AGENT_IDS.length);

    initial.get("codex-sol")!.resolve({ replyCandidates: ["codex-terra", "claude-sonnet", "claude-opus"] });
    await vi.waitFor(() => expect(seenAgents).toEqual([...AGENT_IDS, "codex-terra"]));
    for (const agent of AGENT_IDS) {
      if (agent !== "codex-terra" && agent !== "codex-sol") initial.get(agent)!.resolve({});
    }
    lunaReaction.resolve({});
    await conversation;
  });

  it("limits concurrent bulk agent launches", async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((next) => { resolve = next; });
      return { promise, resolve };
    }
    const completions = AGENT_IDS.map(() => deferred<TurnResult>());
    let active = 0;
    let maximumActive = 0;
    const performTurn = vi.fn((turn: ConversationTurn) => {
      const index = AGENT_IDS.findIndex((agent) => agent === turn.agent);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return completions[index].promise.finally(() => { active -= 1; });
    });

    const conversation = runAgentConversation(candidatesForAllAgents(), 0, performTurn, 3);
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(3));
    completions[0].resolve({});
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(4));
    for (const completion of completions) completion.resolve({});
    await conversation;

    expect(maximumActive).toBe(3);
  });
});

describe("room message policy", () => {
  it("ranks every configured agent as a staged candidate", () => {
    const turns = roomMessageTurns(roomState([]));
    expect(new Set(turns.map(({ agent }) => agent))).toEqual(new Set(AGENT_IDS));
    expect(turns[0]?.instruction).toContain("decide whether the message is actually directed at you");
    expect(turns[0]?.instruction).toContain("otherwise use NO_RESPONSE_NEEDED");
  });

  it("prefers conversational continuity while preserving quiet-time and jitter inputs", () => {
    const state = roomState([
      { id: "sol", speaker: "codex-sol", text: "I can bring snacks.", timestamp: "2026-08-19T12:00:00Z" },
      { id: "human", speaker: "you", text: "Please improve those snacks.", timestamp: "2026-08-19T12:00:01Z" },
    ]);
    expect(rankRoomAgents(state, () => 0)[0]).toBe("codex-sol");
  });

  it.each([
    "How's everyone doing tonight?",
    "What do you all think?",
    "How are y'all feeling?",
    "Hey all, any dinner preferences?",
    "I'd like to hear from the whole room.",
  ])("recognizes an explicit whole-room invitation: %s", (text) => {
    const state = roomState([{ id: "human", speaker: "you", text, timestamp: "2026-08-19T12:00:00Z" }]);

    expect(latestHumanInvitesWholeRoom(state)).toBe(true);
    expect(roomMessageTurns(state)[0]?.instruction).toContain("explicitly invites the whole room");
  });

  it("does not treat a generic open question as an invitation to every agent", () => {
    const state = roomState([{
      id: "human",
      speaker: "you",
      text: "What should we listen to next?",
      timestamp: "2026-08-19T12:00:00Z",
    }]);

    expect(latestHumanInvitesWholeRoom(state)).toBe(false);
  });

  it("respects an explicit statement that the whole room need not answer", () => {
    const state = roomState([{
      id: "human",
      speaker: "you",
      text: "Not everyone needs to answer, but what should we listen to next?",
      timestamp: "2026-08-19T12:00:00Z",
    }]);

    expect(latestHumanInvitesWholeRoom(state)).toBe(false);
  });
});

describe("conversation energy", () => {
  const candidates = candidatesForAllAgents();

  it("falls through silent candidates until one agent chooses to respond", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 0 })
      .mockResolvedValueOnce({ visibleMessageCount: 1 });

    await runEnergyConversation(candidates, "low", performTurn, () => 0);

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-terra", "codex-sol"]);
  });

  it("stages a second balanced invitation after the first visible response", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1 })
      .mockResolvedValueOnce({ visibleMessageCount: 1 });

    await runEnergyConversation(candidates, "balanced", performTurn, () => 0);

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-terra", "codex-sol"]);
    expect(performTurn.mock.calls[1][0].instruction).toContain("optional chance to join");
  });

  it("sometimes conserves balanced energy after one response", async () => {
    const performTurn = vi.fn().mockResolvedValue({ visibleMessageCount: 1 });

    await runEnergyConversation(candidates, "balanced", performTurn, () => 0.99);

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-terra"]);
  });

  it("seeks another participant when an agent explicitly leaves a point open", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "open" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "settled" })
      .mockResolvedValueOnce({ visibleMessageCount: 0 });

    await runEnergyConversation(candidates, "balanced", performTurn, () => 0.99);

    expect(performTurn.mock.calls.slice(0, 2).map(([turn]) => turn.agent)).toEqual(["codex-terra", "codex-sol"]);
  });

  it("explains when an open point receives no second participant", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "open" })
      .mockResolvedValue({ visibleMessageCount: 0 });

    const result = await runEnergyConversation(candidates, "low", performTurn, () => 1);

    expect(result.pauseReason).toContain("no second agent");
    expect(performTurn).toHaveBeenCalledTimes(AGENT_IDS.length);
  });

  it("lets every configured agent participate at party energy", async () => {
    const performTurn = vi.fn().mockResolvedValue({ visibleMessageCount: 1, conversationState: "settled" });

    await runEnergyConversation(candidates, "party", performTurn, () => 0);

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(AGENT_IDS);
  });

  it("synthesizes, checks objections, and reconciles an explicitly open discussion", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "open" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "settled" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "open" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "open" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "settled" });

    const result = await runEnergyConversation(candidates, "balanced", performTurn, () => 0);

    expect(result).toEqual({ settled: true });
    expect(performTurn).toHaveBeenCalledTimes(5);
    expect(performTurn.mock.calls[2][0].instruction).toContain("discussion synthesizer");
    expect(performTurn.mock.calls[3][0].instruction).toContain("material omission");
    expect(performTurn.mock.calls[4][0].instruction).toContain("Reconcile");
  });

  it("reports when synthesis is blocked on human input", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "open" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "open" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "blocked" });

    const result = await runEnergyConversation(candidates, "balanced", performTurn, () => 0);

    expect(result).toEqual({ settled: false, pauseReason: "The agents need human input to resolve the remaining decision." });
  });

  it("offers every agent one concise turn when the human invites the whole room", async () => {
    const performTurn = vi.fn().mockResolvedValue({ visibleMessageCount: 1 });

    await runEnergyConversation(candidates, "low", performTurn, () => 1, { inviteAll: true });

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(AGENT_IDS);
    expect(performTurn.mock.calls.every(([turn]) => turn.visibleMessageLimit === 1)).toBe(true);
  });

  it("still offers the whole room a turn when an invited agent stays silent", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 0 })
      .mockResolvedValue({ visibleMessageCount: 1 });

    await runEnergyConversation(candidates, "balanced", performTurn, () => 1, { inviteAll: true });

    expect(performTurn).toHaveBeenCalledTimes(AGENT_IDS.length);
  });

  it("honors direct invitations across the soft budget but stops at the hard ceiling", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, mentionedAgents: ["claude-sonnet"] })
      .mockResolvedValueOnce({ visibleMessageCount: 1, mentionedAgents: ["codex-sol"] })
      .mockResolvedValueOnce({ visibleMessageCount: 1, mentionedAgents: ["claude-opus"] });

    await runEnergyConversation(candidates, "low", performTurn, () => 1);

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-terra", "claude-sonnet", "codex-sol"]);
    expect(performTurn.mock.calls.every(([turn]) => turn.visibleMessageLimit! <= 3)).toBe(true);
  });

  it("offers a fresh candidate the floor when a response contains a real continuation cue", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, continuationWorthy: true })
      .mockResolvedValueOnce({ visibleMessageCount: 0 })
      .mockResolvedValueOnce({ visibleMessageCount: 1 });

    await runEnergyConversation(candidates, "balanced", performTurn, () => 0);

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-terra", "codex-sol", "claude-sonnet"]);
  });

  it("stops immediately when new human activity cancels the current pulse", async () => {
    const performTurn = vi.fn().mockResolvedValue({ cancelled: true });

    await runEnergyConversation(candidates, "party", performTurn, () => 0);

    expect(performTurn).toHaveBeenCalledTimes(1);
  });

  it("prevents the same pair from recursively inviting each other", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, mentionedAgents: ["claude-sonnet"] })
      .mockResolvedValueOnce({ visibleMessageCount: 1, mentionedAgents: ["codex-terra"] })
      .mockResolvedValueOnce({ visibleMessageCount: 1, mentionedAgents: ["claude-sonnet"] })
      .mockResolvedValue({ visibleMessageCount: 0 });

    await runEnergyConversation(candidates, "party", performTurn, () => 1);

    const speakers = performTurn.mock.calls.map(([turn]) => turn.agent);
    expect(speakers.slice(0, 3)).toEqual(["codex-terra", "claude-sonnet", "codex-terra"]);
    expect(speakers.filter((agent) => agent === "claude-sonnet")).toHaveLength(1);
  });
});

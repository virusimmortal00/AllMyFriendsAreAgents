import { describe, expect, it, vi } from "vitest";
import { latestHumanBroadcastPolicy, latestHumanInvitesWholeRoom, parseAgentTurn, rankRoomAgents, roomMessageTurns, runAgentConversation, runEnergyConversation, type ConversationTurn, type TurnResult } from "./conversation.js";
import type { AgentId, RoomMessage, RoomState } from "./types.js";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { AGENT_IDS } from "../shared/participants.js";
import { emptyRoomAgentRoster } from "../shared/roster.js";

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
  it("normalizes only the current speaker's leading label without changing burst limits", () => {
    expect(parseAgentTurn("codex-sol", '[SOL] First.\n<<<NEXT>>>\n[Sol] Second.\n<<<NEXT>>>\n[aside] Third.\nTURN_DISPOSITION: {"action":"speak"}', undefined, 2)).toMatchObject({
      visibleMessages: ["First.", "Second."], disposition: "speak",
    });
    expect(parseAgentTurn("codex-sol", '[SOL] TURN_DISPOSITION: {"action":"yield","reason":"already_covered"}')).toMatchObject({
      visibleMessages: [], yieldReason: "already_covered",
    });
    expect(parseAgentTurn("codex-sol", "Plan mode is active.\n\n[SOL] A useful answer.").visibleMessages).toEqual(["A useful answer."]);
    expect(parseAgentTurn("codex-sol", "[aside] A useful answer.").visibleMessages).toEqual(["[aside] A useful answer."]);
  });

  it("removes disposition metadata and recognizes a mention of the other agent", () => {
    expect(parseAgentTurn("codex-sol", "Claude, what do you think?\n\nDISPOSITION: PROPOSAL")).toEqual({
      diagnostics: expect.any(Object),
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

  it("keeps a bounded investigation request private and rejects malformed requests", () => {
    expect(parseAgentTurn("codex-sol", "I saw an identity mismatch.\n\nINVESTIGATION_REQUEST: {\"objective\":\"Corroborate the identity mapping\",\"trigger\":\"Two labels mapped to one participant\",\"evidenceRefs\":[{\"kind\":\"project_artifact\",\"ref\":\"server/types.ts\"}]}" )).toMatchObject({
      visibleMessages: ["I saw an identity mismatch."], investigationRequest: { objective: "Corroborate the identity mapping", trigger: "Two labels mapped to one participant", evidenceRefs: [{ kind: "project_artifact", ref: "server/types.ts" }] },
    });
    expect(parseAgentTurn("codex-sol", "Normal reply.\nINVESTIGATION_REQUEST: {not-json}")).not.toHaveProperty("investigationRequest");
  });

  it("suppresses a no-response decision", () => {
    expect(parseAgentTurn("claude-sonnet", "NO_RESPONSE_NEEDED")).toEqual({
      diagnostics: expect.any(Object),
      visibleMessages: [],
      replyCandidates: [],
      mentionedAgents: [],
      visibleMessageCount: 0,
      continuationWorthy: false,
    });
  });

  it("suppresses legacy explanatory prose that terminates in the no-response marker", () => {
    expect(parseAgentTurn("claude-sonnet", "That is directed at another agent, so I should stand down. NO_RESPONSE_NEEDED").visibleMessages).toEqual([]);
  });

  it("accepts a structured yield without exposing its reason as chat", () => {
    expect(parseAgentTurn("claude-sonnet", "TURN_DISPOSITION: {\"action\":\"yield\",\"reason\":\"already_covered\"}")).toMatchObject({
      visibleMessages: [],
      yieldReason: "already_covered",
    });
  });

  it("fails closed when a structured disposition is malformed", () => {
    expect(parseAgentTurn("claude-sonnet", "This must not leak.\nTURN_DISPOSITION: {not-json}").visibleMessages).toEqual([]);
  });

  it("delivers speaking text while stripping a valid speaking disposition", () => {
    expect(parseAgentTurn("claude-sonnet", "A distinct contribution.\nTURN_DISPOSITION: {\"action\":\"speak\"}\nCONVERSATION_STATE: SETTLED")).toMatchObject({
      visibleMessages: ["A distinct contribution."],
      disposition: "speak",
      conversationState: "settled",
    });
  });

  it("extracts and validates an agent's private style directive", () => {
    expect(parseAgentTurn(
      "claude-sonnet",
      "A useful answer.\nSTYLE: {\"fontFamily\":\"Comic Sans MS\",\"fontSize\":22,\"textColor\":\"#ED36FF\",\"backgroundColor\":\"#ECECEC\",\"bold\":true,\"italic\":false,\"underline\":false}",
      DEFAULT_PARTICIPANT_STYLES["claude-sonnet"],
    )).toEqual({
      diagnostics: expect.any(Object),
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
  it("does not schedule a provider turn for an empty room roster", async () => {
    const state = { ...roomState([]), roster: emptyRoomAgentRoster() };
    const performTurn = vi.fn();

    expect(rankRoomAgents(state)).toEqual([]);
    await runAgentConversation([], 3, performTurn);
    expect(performTurn).not.toHaveBeenCalled();
  });

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

    initial.get("claude-sonnet")!.resolve({});
    await Promise.resolve();
    expect(performTurn).toHaveBeenCalledTimes(AGENT_IDS.length);

    initial.get("codex-sol")!.resolve({ replyCandidates: ["claude-sonnet", "claude-opus"] });
    await vi.waitFor(() => expect(seenAgents).toEqual([...AGENT_IDS, "claude-sonnet"]));
    for (const agent of AGENT_IDS) {
      if (agent !== "claude-sonnet" && agent !== "codex-sol") initial.get(agent)!.resolve({});
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
    expect(turns[0]?.instruction).toContain("TURN_DISPOSITION");
  });

  it("sanctions a cheap one-line reaction for a conversational human message", () => {
    const state = roomState([{
      id: "human-joke",
      speaker: "you",
      text: "Five agents walk into a server and somehow I'm still doing stand-up.",
      timestamp: "2026-08-21T12:00:00.000Z",
    }]);

    expect(latestHumanBroadcastPolicy(state).conversationalFloor).toBe(true);
    expect(roomMessageTurns(state)[0]?.instruction).toContain("one-line social reaction is a valid response");
    expect(roomMessageTurns(state)[0]?.instruction).toContain("does not bar your own distinct-flavored reaction");
  });

  it("prefers conversational continuity while preserving quiet-time and jitter inputs", () => {
    const state = roomState([
      { id: "sol", speaker: "codex-sol", text: "I can bring snacks.", timestamp: "2026-08-19T12:00:00Z" },
      { id: "human", speaker: "you", text: "Please improve those snacks.", timestamp: "2026-08-19T12:00:01Z" },
    ]);
    expect(rankRoomAgents(state, () => 0)[0]).toBe("codex-sol");
  });

  it("makes a structured direct mention reply-by-default", () => {
    const state = roomState([{
      id: "human-mention",
      speaker: "you",
      humanId: "alice",
      speakerName: "Alice",
      text: "@Flash any thoughts?",
      timestamp: "2026-08-21T12:00:00.000Z",
      mentions: [{ targetKind: "agent", targetId: "cursor-gemini-flash", label: "Flash", revision: 1, start: 0, end: 6 }],
    }]);

    expect(rankRoomAgents(state, () => 0)[0]).toBe("cursor-gemini-flash");
    const turns = roomMessageTurns(state);
    expect(turns).toHaveLength(AGENT_IDS.length);
    const instruction = turns.find(({ agent }) => agent === "cursor-gemini-flash")?.instruction;
    expect(instruction).toContain("Reply by default");
    expect(instruction).toContain("TURN_DISPOSITION");
    expect(instruction).not.toContain("NO_RESPONSE_NEEDED");
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

  it.each([
    "You guys can all read code?",
    "Can you all see the diff?",
    "Could anyone review this?",
    "Anyone can grab this task",
  ])("routes a single-answer broadcast through the settled-response guard: %s", (text) => {
    const state = roomState([{ id: "human", speaker: "you", text, timestamp: "2026-08-19T12:00:00Z" }]);

    expect(latestHumanBroadcastPolicy(state)).toEqual({ inviteAll: false, stopOnSettledResponse: true, conversationalFloor: false });
    expect(roomMessageTurns(state)[0]?.instruction).not.toContain("explicitly invites the whole room");
  });

  it("preserves an explicit request for distinct answers", () => {
    const state = roomState([{
      id: "human",
      speaker: "you",
      text: "Can you all each share your own take?",
      timestamp: "2026-08-19T12:00:00Z",
    }]);

    expect(latestHumanBroadcastPolicy(state)).toEqual({ inviteAll: true, stopOnSettledResponse: false, conversationalFloor: false });
  });

  it("recognizes each-of-you phrasing as an explicit request for distinct answers", () => {
    const state = roomState([{
      id: "human",
      speaker: "you",
      text: "Each of you, share one concern.",
      timestamp: "2026-08-19T12:00:00Z",
    }]);

    expect(latestHumanBroadcastPolicy(state)).toEqual({ inviteAll: true, stopOnSettledResponse: false, conversationalFloor: false });
    expect(roomMessageTurns(state)[0]?.instruction).toContain("explicitly invites the whole room");
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

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((next, fail) => {
      resolve = next;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  it("keeps low-energy openings single-participant even with spare concurrency", async () => {
    const first = deferred<TurnResult>();
    const second = deferred<TurnResult>();
    const performTurn = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const conversation = runEnergyConversation(candidates, "low", performTurn, () => 0, { concurrencyLimit: 3 });
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(1));
    first.resolve({ visibleMessageCount: 0 });
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(2));
    second.resolve({ visibleMessageCount: 1 });
    await conversation;

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-sol", "claude-sonnet"]);
  });

  it("falls through failed participants without cancelling the room pulse", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ failed: true })
      .mockResolvedValueOnce({ visibleMessageCount: 1 });

    const result = await runEnergyConversation(candidates, "low", performTurn, () => 0);

    expect(result).toEqual({ settled: true, summary: expect.any(Object) });
    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-sol", "claude-sonnet"]);
  });

  it("stages a second balanced invitation after the first visible response", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1 })
      .mockResolvedValueOnce({ visibleMessageCount: 1 });

    await runEnergyConversation(candidates, "balanced", performTurn, () => 0);

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-sol", "claude-sonnet"]);
    expect(performTurn.mock.calls[1][0].instruction).toContain("optional chance to join");
    expect(performTurn.mock.calls[1][0].instruction).toContain("distinct, natural contribution");
    expect(performTurn.mock.calls[1][0].instruction).toContain("TURN_DISPOSITION");
  });

  it("allows a cheap distinct-flavored reaction in an ambient conversational follow-up", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1 })
      .mockResolvedValueOnce({ visibleMessageCount: 0 });

    await runEnergyConversation(candidates, "balanced", performTurn, () => 0, { conversationalFloor: true });

    expect(performTurn).toHaveBeenCalledTimes(2);
    expect(performTurn.mock.calls[1][0].instruction).toContain("one-line reaction is welcome");
    expect(performTurn.mock.calls[1][0].instruction).toContain("does not bar your own distinct-flavored reaction");
    expect(performTurn.mock.calls[1][0].instruction).toContain("Do not manufacture a question");
  });

  it("fires the conversational floor exactly once after every invited agent declines", async () => {
    const state = roomState([{
      id: "human-joke",
      speaker: "you",
      text: "Five agents walk into a server and somehow I'm still doing stand-up.",
      timestamp: "2026-08-21T12:00:00.000Z",
    }]);
    const turns = roomMessageTurns(state);
    const performTurn = vi.fn().mockResolvedValue({ visibleMessageCount: 0 });

    await runEnergyConversation(turns, "low", performTurn, () => 1, latestHumanBroadcastPolicy(state));

    expect(performTurn).toHaveBeenCalledTimes(turns.length + 1);
    expect(performTurn.mock.calls.at(-1)?.[0].agent).toBe(turns[0].agent);
    expect(performTurn.mock.calls.at(-1)?.[0].instruction).toContain("Nobody has reacted yet");
    expect(performTurn.mock.calls.at(-1)?.[0].instruction).toContain("one final conversational-floor turn");
  });

  it.each([
    "Please implement the cursor migration and run the tests.",
    "Thanks, that's all for now.",
  ])("does not fire the conversational floor for task-shaped or settled text: %s", async (text) => {
    const state = roomState([{ id: "human", speaker: "you", text, timestamp: "2026-08-21T12:00:00.000Z" }]);
    const turns = roomMessageTurns(state);
    const performTurn = vi.fn().mockResolvedValue({ visibleMessageCount: 0 });

    await runEnergyConversation(turns, "low", performTurn, () => 1, latestHumanBroadcastPolicy(state));

    expect(latestHumanBroadcastPolicy(state).conversationalFloor).toBe(false);
    expect(performTurn).toHaveBeenCalledTimes(turns.length);
    expect(performTurn.mock.calls.every(([turn]) => !turn.instruction.includes("Nobody has reacted yet"))).toBe(true);
  });

  it("does not treat failed generations as conversational declines", async () => {
    const performTurn = vi.fn().mockResolvedValue({ failed: true });

    await runEnergyConversation(candidates, "low", performTurn, () => 1, { conversationalFloor: true });

    expect(performTurn).toHaveBeenCalledTimes(candidates.length);
  });

  it("overlaps independently selected openings and refills slots in completion order", async () => {
    const completions = new Map<AgentId, ReturnType<typeof deferred<TurnResult>>>(
      AGENT_IDS.slice(0, 3).map((agent) => [agent, deferred<TurnResult>()]),
    );
    const completionOrder: AgentId[] = [];
    let active = 0;
    let peakActive = 0;
    const performTurn = vi.fn((turn: ConversationTurn) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      return completions.get(turn.agent)!.promise.then((result) => {
        completionOrder.push(turn.agent);
        return result;
      }).finally(() => {
        active -= 1;
      });
    });

    const conversation = runEnergyConversation(candidates, "lively", performTurn, () => 0, { concurrencyLimit: 2 });
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(2));
    completions.get("claude-sonnet")!.resolve({ visibleMessageCount: 1 });
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(3));
    completions.get("cursor-grok")!.resolve({ visibleMessageCount: 1 });
    await vi.waitFor(() => expect(completionOrder).toEqual(["claude-sonnet", "cursor-grok"]));
    completions.get("codex-sol")!.resolve({ visibleMessageCount: 1 });
    await conversation;

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(AGENT_IDS.slice(0, 3));
    expect(performTurn.mock.calls.every(([turn]) => turn.visibleMessageLimit === 1)).toBe(true);
    expect(completionOrder).toEqual(["claude-sonnet", "cursor-grok", "codex-sol"]);
    expect(peakActive).toBe(2);
  });

  it("sometimes conserves balanced energy after one response", async () => {
    const performTurn = vi.fn().mockResolvedValue({ visibleMessageCount: 1 });

    await runEnergyConversation(candidates, "balanced", performTurn, () => 0.99, { concurrencyLimit: 3 });

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-sol"]);
  });

  it("seeks another participant when an agent explicitly leaves a point open", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "open" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "settled" })
      .mockResolvedValueOnce({ visibleMessageCount: 0 });

    await runEnergyConversation(candidates, "balanced", performTurn, () => 0.99);

    expect(performTurn.mock.calls.slice(0, 2).map(([turn]) => turn.agent)).toEqual(["codex-sol", "claude-sonnet"]);
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

  it("keeps synthesis, objections, and reconciliation ordered after concurrent openings", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "open" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "settled" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "open" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "open" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "settled" });

    const result = await runEnergyConversation(candidates, "balanced", performTurn, () => 0, { concurrencyLimit: 2 });

    expect(result).toEqual({ settled: true, summary: expect.any(Object) });
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

    expect(result).toEqual({ settled: false, pauseReason: "The agents need human input to resolve the remaining decision.", summary: expect.any(Object) });
  });

  it("offers every agent one concise turn when the human invites the whole room", async () => {
    const performTurn = vi.fn().mockResolvedValue({ visibleMessageCount: 1 });

    await runEnergyConversation(candidates, "low", performTurn, () => 1, { inviteAll: true });

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(AGENT_IDS);
    expect(performTurn.mock.calls.every(([turn]) => turn.visibleMessageLimit === 1)).toBe(true);
  });

  it("bounds whole-room invitations by the configured concurrency limit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let peakActive = 0;
    const performTurn = vi.fn(async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await gate;
      active -= 1;
      return { visibleMessageCount: 1 };
    });

    const conversation = runEnergyConversation(candidates, "low", performTurn, () => 1, {
      inviteAll: true,
      concurrencyLimit: 3,
    });
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(3));
    expect(peakActive).toBe(3);
    release();
    await conversation;

    expect(performTurn).toHaveBeenCalledTimes(AGENT_IDS.length);
    expect(peakActive).toBe(3);
  });

  it("still offers the whole room a turn when an invited agent stays silent", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 0 })
      .mockResolvedValue({ visibleMessageCount: 1 });

    await runEnergyConversation(candidates, "balanced", performTurn, () => 1, { inviteAll: true });

    expect(performTurn).toHaveBeenCalledTimes(AGENT_IDS.length);
  });

  it("closes a flood-prone broadcast after the first settled visible response", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 0 })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "settled" })
      .mockResolvedValue({ visibleMessageCount: 1, conversationState: "settled" });

    const result = await runEnergyConversation(candidates, "party", performTurn, () => 0, {
      stopOnSettledResponse: true,
      concurrencyLimit: 3,
    });

    expect(result).toEqual({ settled: true, summary: expect.any(Object) });
    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-sol", "claude-sonnet"]);
  });

  it("closes a flood-prone broadcast when a later response settles an initially open answer", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "open" })
      .mockResolvedValueOnce({ visibleMessageCount: 1, conversationState: "settled" })
      .mockResolvedValue({ visibleMessageCount: 1, conversationState: "settled" });

    await runEnergyConversation(candidates, "party", performTurn, () => 0, {
      stopOnSettledResponse: true,
      concurrencyLimit: 3,
    });

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-sol", "claude-sonnet"]);
  });

  it("keeps collecting explicitly requested takes when the settled-response guard is absent", async () => {
    const performTurn = vi.fn().mockResolvedValue({ visibleMessageCount: 1, conversationState: "settled" });

    await runEnergyConversation(candidates, "party", performTurn, () => 0, { inviteAll: true });

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(AGENT_IDS);
  });

  it("honors direct invitations across the soft budget but stops at the hard ceiling", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, mentionedAgents: ["claude-sonnet"] })
      .mockResolvedValueOnce({ visibleMessageCount: 1, mentionedAgents: ["codex-sol"] })
      .mockResolvedValueOnce({ visibleMessageCount: 1, mentionedAgents: ["claude-opus"] });

    await runEnergyConversation(candidates, "low", performTurn, () => 1);

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-sol", "claude-sonnet", "codex-sol"]);
    expect(performTurn.mock.calls.every(([turn]) => turn.visibleMessageLimit! <= 3)).toBe(true);
  });

  it("offers a fresh candidate the floor when a response contains a real continuation cue", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, continuationWorthy: true })
      .mockResolvedValueOnce({ visibleMessageCount: 0 })
      .mockResolvedValueOnce({ visibleMessageCount: 1 });

    await runEnergyConversation(candidates, "balanced", performTurn, () => 0);

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual(["codex-sol", "claude-sonnet", "cursor-grok"]);
  });

  it("waits for opening prerequisites before launching mention-driven follow-ups", async () => {
    const first = deferred<TurnResult>();
    const second = deferred<TurnResult>();
    let firstCompleted = false;
    const performTurn = vi.fn((turn: ConversationTurn) => {
      if (turn.agent === "codex-sol") return first.promise.then((result) => {
        firstCompleted = true;
        return result;
      });
      if (turn.agent === "claude-sonnet") return second.promise;
      return Promise.resolve({ visibleMessageCount: 0 });
    });

    const conversation = runEnergyConversation(candidates, "balanced", performTurn, () => 0, { concurrencyLimit: 2 });
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(2));
    first.resolve({ visibleMessageCount: 1, mentionedAgents: ["cursor-grok"] });
    await vi.waitFor(() => expect(firstCompleted).toBe(true));
    expect(performTurn).toHaveBeenCalledTimes(2);
    second.resolve({ visibleMessageCount: 1 });
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(3));
    await conversation;

    expect(performTurn.mock.calls[2][0]).toMatchObject({ agent: "cursor-grok" });
    expect(performTurn.mock.calls[2][0].instruction).toContain("addressed you directly");
    expect(performTurn.mock.calls[2][0].instruction).toContain("Reply by default");
    expect(performTurn.mock.calls[2][0].instruction).toContain("Silence is exceptional");
    expect(performTurn.mock.calls[2][0].instruction).toContain("TURN_DISPOSITION");
  });

  it("preserves a mention follow-up when the concurrent target completes last", async () => {
    const first = deferred<TurnResult>();
    const second = deferred<TurnResult>();
    const turnCounts = new Map<AgentId, number>();
    const performTurn = vi.fn((turn: ConversationTurn) => {
      const count = turnCounts.get(turn.agent) || 0;
      turnCounts.set(turn.agent, count + 1);
      if (turn.agent === "codex-sol") return first.promise;
      if (turn.agent === "claude-sonnet" && count === 0) return second.promise;
      return Promise.resolve({ visibleMessageCount: 0 });
    });

    const conversation = runEnergyConversation(candidates, "balanced", performTurn, () => 0, { concurrencyLimit: 2 });
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(2));
    first.resolve({ visibleMessageCount: 1, mentionedAgents: ["claude-sonnet"] });
    second.resolve({ visibleMessageCount: 1 });
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(3));
    await conversation;

    expect(performTurn.mock.calls.map(([turn]) => turn.agent)).toEqual([
      "codex-sol",
      "claude-sonnet",
      "claude-sonnet",
    ]);
    expect(performTurn.mock.calls[2][0].instruction).toContain("addressed you directly");
    expect(performTurn.mock.calls[2][0].instruction).toContain("Reply by default");
  });

  it("stops launching queued openings after concurrent cancellation", async () => {
    const first = deferred<TurnResult>();
    const second = deferred<TurnResult>();
    let firstCompleted = false;
    const performTurn = vi.fn()
      .mockImplementationOnce(() => first.promise.then((result) => {
        firstCompleted = true;
        return result;
      }))
      .mockImplementationOnce(() => second.promise);

    const conversation = runEnergyConversation(candidates, "party", performTurn, () => 0, { concurrencyLimit: 2 });
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(2));
    first.resolve({ cancelled: true });
    await vi.waitFor(() => expect(firstCompleted).toBe(true));
    expect(performTurn).toHaveBeenCalledTimes(2);
    second.resolve({ cancelled: true });

    await expect(conversation).resolves.toEqual({ settled: false, summary: expect.any(Object) });
    expect(performTurn).toHaveBeenCalledTimes(2);
  });

  it("drains concurrent failures without launching more work or leaking rejections", async () => {
    const first = deferred<TurnResult>();
    const second = deferred<TurnResult>();
    const firstError = new Error("first opening failed");
    const secondError = new Error("second opening failed");
    const performTurn = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const conversation = runEnergyConversation(candidates, "party", performTurn, () => 0, { concurrencyLimit: 2 });
    const observed = conversation.then(
      () => undefined,
      (error: unknown) => error,
    );
    let finished = false;
    void observed.then(() => { finished = true; });
    await vi.waitFor(() => expect(performTurn).toHaveBeenCalledTimes(2));
    first.reject(firstError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    second.reject(secondError);

    await expect(observed).resolves.toBe(firstError);
    expect(performTurn).toHaveBeenCalledTimes(2);
  });

  it("prevents the same pair from recursively inviting each other", async () => {
    const performTurn = vi.fn()
      .mockResolvedValueOnce({ visibleMessageCount: 1, mentionedAgents: ["claude-sonnet"] })
      .mockResolvedValueOnce({ visibleMessageCount: 1, mentionedAgents: ["codex-sol"] })
      .mockResolvedValueOnce({ visibleMessageCount: 1, mentionedAgents: ["claude-sonnet"] })
      .mockResolvedValue({ visibleMessageCount: 0 });

    await runEnergyConversation(candidates, "party", performTurn, () => 1);

    const speakers = performTurn.mock.calls.map(([turn]) => turn.agent);
    expect(speakers.slice(0, 3)).toEqual(["codex-sol", "claude-sonnet", "codex-sol"]);
    expect(speakers.filter((agent) => agent === "claude-sonnet")).toHaveLength(1);
  });
});

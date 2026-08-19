import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeChatStyle } from "../shared/chat-style.js";
import { cliAvailability, runAgent } from "./agent-runner.js";
import { deliverBurst } from "./burst-delivery.js";
import { parseAgentTurn, roomMessageTurns, runAgentConversation, type ConversationTurn } from "./conversation.js";
import { GenerationJournal } from "./generation-journal.js";
import { CoalescingJobQueue } from "./job-queue.js";
import { pacingStartTime, responseDelayMs } from "./response-pacing.js";
import { RoomActivity } from "./room-activity.js";
import { RoomEventStream } from "./room-event-stream.js";
import { RoomStore } from "./room-store.js";
import { roomStateWithAvailability } from "./state-response.js";
import type { AgentId, RoomSettings } from "./types.js";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDirectory, "..");
const port = Number(process.env.ALL_MY_FRIENDS_ARE_AGENTS_PORT || process.env.AGENTWIRE_PORT || 4174);
const app = express();
const store = await RoomStore.open(projectRoot);
const generationJournal = await GenerationJournal.open(projectRoot);
const roomEvents = new RoomEventStream();
const jobs = new CoalescingJobQueue();
const roomActivity = new RoomActivity();

app.use(express.json({ limit: "64kb" }));

function broadcast() {
  roomEvents.broadcast(store.snapshot());
}

async function performTurnUnchecked({ agent, instruction, includeDiff = false }: ConversationTurn) {
  const before = store.snapshot();
  const activityRevision = roomActivity.current();
  const pacingStartedAt = pacingStartTime(before.messages, agent, Date.now());
  const result = await runAgent(agent, before, instruction, includeDiff, generationJournal);
  const permission = includeDiff || before.settings.writableAgent !== agent ? "read-only" : "writable";
  const currentStyle = before.settings.participantStyles[agent];
  const parsed = parseAgentTurn(agent, result.text, currentStyle);
  await generationJournal.append({
    type: "generation.interpreted",
    generationId: result.generationId,
    agent,
    visibleMessages: parsed.visibleMessages,
    visibleMessageCount: parsed.visibleMessages.length,
    visibleCharacters: parsed.visibleMessages.reduce((total, message) => total + message.length, 0),
    removedOrProtocolCharacters: Math.max(0, result.text.length - parsed.visibleMessages.reduce((total, message) => total + message.length, 0)),
    noResponse: parsed.visibleMessages.length === 0,
    mentionedAgent: parsed.mentionedAgent,
    styleUpdate: parsed.styleUpdate,
  });

  if (!roomActivity.isCurrent(activityRevision)) {
    await store.clearSession(agent);
    await generationJournal.append({
      type: "generation.delivery",
      generationId: result.generationId,
      agent,
      outcome: "cancelled",
      reason: "room activity changed before delivery",
      deliveredMessageCount: 0,
      totalVisibleMessages: parsed.visibleMessages.length,
    });
    return {};
  }

  const burstId = randomUUID();
  const firstMessage = parsed.visibleMessages[0];
  const generatedElapsed = Date.now() - pacingStartedAt;
  const firstDelay = firstMessage
    ? Math.min(600, responseDelayMs(before.messages, agent, firstMessage, generatedElapsed))
    : 0;
  let burstStarted = false;
  let deliveredMessageCount = 0;
  const completed = await deliverBurst({
    messages: parsed.visibleMessages,
    activity: roomActivity,
    revision: activityRevision,
    firstDelayMs: firstDelay,
    cancel: () => store.clearSession(agent),
    deliver: async (visibleMessage, sequence) => {
      if (!burstStarted) {
        await store.setSession(agent, result.sessionId, permission);
        if (!roomActivity.isCurrent(activityRevision)) return false;
        if (parsed.styleUpdate) await store.updateParticipantStyle(agent, parsed.styleUpdate);
        if (!roomActivity.isCurrent(activityRevision)) return false;
        burstStarted = true;
      }
      if (!roomActivity.isCurrent(activityRevision)) return false;
      await store.addMessage(
        agent,
        visibleMessage,
        includeDiff ? "review" : "chat",
        parsed.styleUpdate || currentStyle,
        { burstId, sequence },
      );
      deliveredMessageCount += 1;
      broadcast();
    },
  });
  if (!completed) {
    await generationJournal.append({
      type: "generation.delivery",
      generationId: result.generationId,
      agent,
      outcome: "cancelled",
      reason: "new room activity interrupted a pending burst",
      deliveredMessageCount,
      totalVisibleMessages: parsed.visibleMessages.length,
      firstDelayMs: firstDelay,
      generationDurationMs: result.durationMs,
    });
    return {};
  }
  if (!roomActivity.isCurrent(activityRevision)) {
    await generationJournal.append({
      type: "generation.delivery",
      generationId: result.generationId,
      agent,
      outcome: "cancelled",
      reason: "room activity changed after burst delivery",
      deliveredMessageCount,
      totalVisibleMessages: parsed.visibleMessages.length,
      firstDelayMs: firstDelay,
      generationDurationMs: result.durationMs,
    });
    return {};
  }
  if (!burstStarted) {
    await store.setSession(agent, result.sessionId, permission);
    if (!roomActivity.isCurrent(activityRevision)) {
      await store.clearSession(agent);
      await generationJournal.append({
        type: "generation.delivery",
        generationId: result.generationId,
        agent,
        outcome: "cancelled",
        reason: "room activity changed while saving a silent response",
        deliveredMessageCount,
        totalVisibleMessages: parsed.visibleMessages.length,
      });
      return {};
    }
    if (parsed.styleUpdate) await store.updateParticipantStyle(agent, parsed.styleUpdate);
    if (!roomActivity.isCurrent(activityRevision)) {
      await store.clearSession(agent);
      await generationJournal.append({
        type: "generation.delivery",
        generationId: result.generationId,
        agent,
        outcome: "cancelled",
        reason: "room activity changed while saving agent preferences",
        deliveredMessageCount,
        totalVisibleMessages: parsed.visibleMessages.length,
      });
      return {};
    }
    broadcast();
  }
  await generationJournal.append({
    type: "generation.delivery",
    generationId: result.generationId,
    agent,
    outcome: parsed.visibleMessages.length === 0 ? "no_response" : "delivered",
    deliveredMessageCount,
    totalVisibleMessages: parsed.visibleMessages.length,
    firstDelayMs: firstDelay,
    generationDurationMs: result.durationMs,
  });
  return { replyCandidate: parsed.replyCandidate, mentionedAgent: parsed.mentionedAgent };
}

async function performTurn(turn: ConversationTurn) {
  try {
    return await performTurnUnchecked(turn);
  } catch (error) {
    roomActivity.interrupt();
    throw error;
  }
}

async function performConversation(turns: ConversationTurn[]) {
  const maxFollowUps = store.snapshot().settings.maxRounds;
  await store.setStatus("working", turns.length === 1 ? turns[0].agent : undefined);
  broadcast();
  await runAgentConversation(turns, maxFollowUps, performTurn);
}

async function runJob(job: () => Promise<void>) {
  try {
    await job();
    await store.setStatus("idle");
  } catch (error) {
    roomActivity.interrupt();
    const message = error instanceof Error ? error.message : String(error);
    await store.addMessage("system", `Agent error: ${message}`, "status");
    await store.setStatus("error", undefined, message);
  } finally {
    broadcast();
  }
}

app.get("/api/state", async (_request, response) => {
  response.json(await roomStateWithAvailability(() => store.snapshot(), cliAvailability));
});

app.get("/api/events", (request, response) => {
  roomEvents.connect(request, response, store.snapshot());
});

app.patch("/api/settings", async (request, response) => {
  const update = request.body as Partial<RoomSettings>;
  if (typeof update.topic === "string") {
    const topic = update.topic.trim().replace(/\s+/g, " ");
    if (!topic || topic.length > 160) return response.status(400).json({ error: "Room topic must be between 1 and 160 characters." });
    if (topic !== store.snapshot().settings.topic) {
      roomActivity.interrupt();
      await store.changeTopic(topic);
    }
  }
  const allowed: Partial<RoomSettings> = {};
  if (["codex", "claude", "nobody"].includes(update.writableAgent || "")) {
    allowed.writableAgent = update.writableAgent;
  }
  if (Number.isInteger(update.maxRounds) && Number(update.maxRounds) >= 1 && Number(update.maxRounds) <= 8) {
    allowed.maxRounds = Number(update.maxRounds);
  }
  if (Object.keys(allowed).length > 0) await store.updateSettings(allowed);
  broadcast();
  response.json(store.snapshot());
});

app.patch("/api/style", async (request, response) => {
  const currentStyle = store.snapshot().settings.participantStyles.you;
  await store.updateParticipantStyle("you", sanitizeChatStyle(request.body, currentStyle));
  broadcast();
  response.json(store.snapshot());
});

app.post("/api/messages", async (request, response) => {
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  if (!text) return response.status(400).json({ error: "Message text is required." });
  roomActivity.interrupt();
  await store.addMessage("you", text, "chat", store.snapshot().settings.participantStyles.you);
  broadcast();

  jobs.enqueue("message-conversation", () => runJob(async () => {
    await performConversation(roomMessageTurns());
  }));
  return response.status(202).json(store.snapshot());
});

app.post("/api/actions", async (request, response) => {
  const action = request.body?.action as "ask" | "review" | "roundtable";
  const target = request.body?.target as AgentId | "both";
  if (jobs.busy) return response.status(409).json({ error: "The room is already working." });
  if (!(["ask", "review", "roundtable"].includes(action))) {
    return response.status(400).json({ error: "Unknown room action." });
  }
  if (!["codex", "claude", "both"].includes(target)) {
    return response.status(400).json({ error: "Unknown action target." });
  }

  const agents: AgentId[] = target === "both" ? ["codex", "claude"] : [target];
  jobs.enqueue(`action:${action}:${target}`, () => runJob(async () => {
    await performConversation(agents.map((agent) => ({
      agent,
      instruction: action === "roundtable"
        ? "Join the discussion with the most useful opening thought. React to the room naturally and stop escalating once further replies would add noise."
        : action === "review"
          ? "Review the current worktree changes. Focus on correctness, clarity, security, accessibility, and missing tests. Report concrete findings before general observations."
          : "Read the room and contribute the most useful next thought.",
      includeDiff: action === "review",
    })));
  }));
  return response.status(202).json({ accepted: true });
});

app.use(express.static(path.join(projectRoot, "dist")));
app.get("/{*splat}", (_request, response) => response.sendFile(path.join(projectRoot, "dist", "index.html")));

app.listen(port, "127.0.0.1", () => {
  console.log(`AllMyFriendsAreAgents API listening at http://127.0.0.1:${port}`);
});

import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONVERSATION_ENERGY_POLICIES, isConversationEnergy } from "../shared/conversation-energy.js";
import { AGENT_IDS, isAgentId, normalizeWritableAgent } from "../shared/participants.js";
import { cliAvailability, isAgentGenerationCancelledError, runAgent } from "./agent-runner.js";
import { deliverBurst } from "./burst-delivery.js";
import { conversationRandom, latestHumanInvitesWholeRoom, parseAgentTurn, roomMessageTurns, runAgentConversation, runEnergyConversation, type ConversationTurn } from "./conversation.js";
import { developerRequestAuthorized, openDeveloperToken } from "./developer-access.js";
import { GenerationJournal } from "./generation-journal.js";
import { HumanPresenceRegistry, humanPresenceAnnouncement, humanPresenceInstruction, type HumanPresenceEvent } from "./human-presence.js";
import { CoalescingJobQueue } from "./job-queue.js";
import { pacingStartTime, responseDelayMs } from "./response-pacing.js";
import { RoomActivity } from "./room-activity.js";
import { RoomEventStream } from "./room-event-stream.js";
import { publicRoomState, roomStateWithAvailability } from "./state-response.js";
import { resolveStorageConfiguration } from "./storage/config.js";
import { openRoomRepository } from "./storage/open-room-repository.js";
import type { AgentId, RoomSettings } from "./types.js";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDirectory, "..");
const port = Number(process.env.ALL_MY_FRIENDS_ARE_AGENTS_PORT || process.env.AGENTWIRE_PORT || 53147);
const host = process.env.ALL_MY_FRIENDS_ARE_AGENTS_HOST || "127.0.0.1";
const agentConcurrency = Math.max(1, Number.parseInt(process.env.ALL_MY_FRIENDS_ARE_AGENTS_AGENT_CONCURRENCY || "3", 10) || 3);
const normalizedHost = host.replace(/^\[|\]$/g, "").toLowerCase();
const isLoopbackHost = normalizedHost === "127.0.0.1" || normalizedHost === "localhost" || normalizedHost === "::1";
if (!isLoopbackHost && process.env.ALL_MY_FRIENDS_ARE_AGENTS_ALLOW_UNAUTHENTICATED_REMOTE !== "true") {
  throw new Error(
    "Refusing to bind the unauthenticated room API to a non-loopback host. "
    + "Use a protected reverse proxy, or explicitly set ALL_MY_FRIENDS_ARE_AGENTS_ALLOW_UNAUTHENTICATED_REMOTE=true.",
  );
}
const app = express();
const storageConfiguration = resolveStorageConfiguration(projectRoot);
const store = await openRoomRepository(projectRoot, storageConfiguration);
const generationJournal = await GenerationJournal.open(projectRoot, storageConfiguration.dataDirectory);
const roomEvents = new RoomEventStream();
const jobs = new CoalescingJobQueue();
const roomActivity = new RoomActivity();
const humans = new HumanPresenceRegistry();
const developerAccess = await openDeveloperToken(storageConfiguration.dataDirectory);
const developerHuman = {
  id: "developer-agent",
  name: process.env.ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_NAME?.trim() || "Developer Agent",
};

app.use(express.json({ limit: "64kb" }));

function roomSnapshot() {
  return { ...store.snapshot(), humans: humans.list() };
}

function broadcast() {
  roomEvents.broadcast(publicRoomState(roomSnapshot()));
}

function developerRoomView(limit = 50) {
  const state = publicRoomState(roomSnapshot());
  const messages = state.messages.slice(-limit);
  return {
    ...state,
    messages,
    busy: jobs.busy,
    cursor: state.messages.at(-1)?.id,
  };
}

function developerAuthorized(authorization: string | undefined) {
  return developerRequestAuthorized(authorization, developerAccess.token);
}

async function performTurnUnchecked({ agent, instruction, includeDiff = false, visibleMessageLimit = 3 }: ConversationTurn) {
  const before = roomSnapshot();
  const activityRevision = roomActivity.current();
  const pacingStartedAt = pacingStartTime(before.messages, agent, Date.now());
  const generationCancellation = roomActivity.abortSignal(activityRevision);
  let result;
  try {
    result = await runAgent(agent, before, instruction, includeDiff, generationJournal, generationCancellation.signal);
  } catch (error) {
    if (isAgentGenerationCancelledError(error)) return { cancelled: true };
    throw error;
  } finally {
    generationCancellation.dispose();
  }
  const permission = includeDiff || before.settings.writableAgent !== agent ? "read-only" : "writable";
  const currentStyle = before.settings.participantStyles[agent];
  const parsed = parseAgentTurn(agent, result.text, currentStyle, visibleMessageLimit);
  await generationJournal.append({
    type: "generation.interpreted",
    generationId: result.generationId,
    agent,
    visibleMessages: parsed.visibleMessages,
    visibleMessageCount: parsed.visibleMessages.length,
    visibleCharacters: parsed.visibleMessages.reduce((total, message) => total + message.length, 0),
    removedOrProtocolCharacters: Math.max(0, result.text.length - parsed.visibleMessages.reduce((total, message) => total + message.length, 0)),
    noResponse: parsed.visibleMessages.length === 0,
    mentionedAgents: parsed.mentionedAgents,
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
    return { cancelled: true };
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
    return { cancelled: true };
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
    return { cancelled: true };
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
      return { cancelled: true };
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
      return { cancelled: true };
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
  return {
    replyCandidates: parsed.replyCandidates,
    mentionedAgents: parsed.mentionedAgents,
    visibleMessageCount: parsed.visibleMessageCount,
    continuationWorthy: parsed.continuationWorthy,
    conversationState: parsed.conversationState,
  };
}

async function performTurn(turn: ConversationTurn) {
  try {
    return await performTurnUnchecked(turn);
  } catch (error) {
    roomActivity.interrupt();
    throw error;
  }
}

async function performConversation(turns: ConversationTurn[], staged = false, inviteAll = false) {
  const snapshot = store.snapshot();
  const energy = snapshot.settings.conversationEnergy;
  await store.setStatus("working", turns.length === 1 ? turns[0].agent : undefined);
  broadcast();
  if (staged) {
    const result = await runEnergyConversation(turns, energy, performTurn, conversationRandom(snapshot), { inviteAll });
    if (result.pauseReason) {
      await store.addMessage("system", `${result.pauseReason} Use Actions → Continue discussion to start another bounded round.`, "status");
      broadcast();
    }
    return;
  }
  const followUpAllowance = Math.max(0, CONVERSATION_ENERGY_POLICIES[energy].hardTurnCeiling - turns.length);
  await runAgentConversation(turns, followUpAllowance, performTurn, agentConcurrency);
}

async function runJob(job: () => Promise<void>) {
  try {
    await job();
    await store.setStatus("idle");
  } catch (error) {
    roomActivity.interrupt();
    console.error("Agent command failed", error);
    await store.addMessage("system", "An agent command failed. Check the server log for details.", "status");
    await store.setStatus("error", undefined, "An agent command failed.");
  } finally {
    broadcast();
  }
}

async function announceHumanPresence(human: { id: string; name: string }, event: HumanPresenceEvent) {
  await store.addMessage("system", humanPresenceAnnouncement(human.name, event), "status");
  broadcast();
  jobs.enqueue(`presence:${event}:${human.id}:${randomUUID()}`, () => runJob(async () => {
    await performConversation(AGENT_IDS.map((agent) => ({
      agent,
      visibleMessageLimit: 1,
      instruction: humanPresenceInstruction(human.name, event),
    })), true);
  }));
}

app.get("/api/state", async (_request, response) => {
  response.json(await roomStateWithAvailability(roomSnapshot, cliAvailability));
});

app.get("/api/events", (request, response) => {
  const humanId = request.query.humanId;
  const connection = humans.connect(humanId);
  if (!connection) return response.status(400).json({ error: "Join the room before connecting." });
  roomEvents.connect(request, response, publicRoomState(roomSnapshot()), () => {
    const departure = humans.disconnect(humanId);
    if (departure?.becameAbsent) {
      void announceHumanPresence(departure.human, "left").catch((error) => console.error("Failed to announce room departure", error));
    } else {
      broadcast();
    }
  });
  broadcast();
  if (connection.becamePresent) {
    void announceHumanPresence(connection.human, "joined").catch((error) => console.error("Failed to announce room arrival", error));
  }
});

app.post("/api/humans", (request, response) => {
  try {
    response.status(201).json(humans.join(request.body || {}));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "A valid name is required." });
  }
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
  if (typeof update.roomName === "string") {
    const roomName = update.roomName.trim().replace(/\s+/g, " ");
    if (!roomName || roomName.length > 80) return response.status(400).json({ error: "Room name must be between 1 and 80 characters." });
    allowed.roomName = roomName;
  }
  if (update.writableAgent === "nobody" || isAgentId(update.writableAgent)) {
    allowed.writableAgent = normalizeWritableAgent(update.writableAgent);
  }
  if (isConversationEnergy(update.conversationEnergy)) {
    allowed.conversationEnergy = update.conversationEnergy;
  }
  if (Object.keys(allowed).length > 0) await store.updateSettings(allowed);
  broadcast();
  response.json(publicRoomState(roomSnapshot()));
});

app.patch("/api/style", async (request, response) => {
  const human = humans.updateStyle(request.body?.humanId, request.body?.style);
  if (!human) return response.status(400).json({ error: "Join the room before changing your style." });
  broadcast();
  response.json(human);
});

app.post("/api/messages", async (request, response) => {
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  if (!text) return response.status(400).json({ error: "Message text is required." });
  const human = humans.get(request.body?.humanId);
  if (!human) return response.status(400).json({ error: "Join the room before sending a message." });
  roomActivity.interrupt();
  await store.addMessage("you", text, "chat", human.style, undefined, human);
  broadcast();

  jobs.enqueue("message-conversation", () => runJob(async () => {
    const conversationState = roomSnapshot();
    await performConversation(
      roomMessageTurns(conversationState),
      true,
      latestHumanInvitesWholeRoom(conversationState),
    );
  }));
  return response.status(202).json(publicRoomState(roomSnapshot()));
});

app.get("/api/developer/room", (request, response) => {
  if (!developerAuthorized(request.header("authorization"))) return response.status(404).json({ error: "Not found." });
  const requestedLimit = Number(request.query.limit || 50);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, Math.floor(requestedLimit))) : 50;
  response.json(developerRoomView(limit));
});

app.post("/api/developer/messages", async (request, response) => {
  if (!developerAuthorized(request.header("authorization"))) return response.status(404).json({ error: "Not found." });
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  if (!text) return response.status(400).json({ error: "Message text is required." });
  if (text.length > 16_000) return response.status(400).json({ error: "Developer messages are limited to 16,000 characters." });

  roomActivity.interrupt();
  const message = await store.addMessage("you", text, "chat", undefined, undefined, developerHuman);
  broadcast();
  jobs.enqueue("developer-message-conversation", () => runJob(async () => {
    const conversationState = roomSnapshot();
    await performConversation(
      roomMessageTurns(conversationState),
      true,
      latestHumanInvitesWholeRoom(conversationState),
    );
  }));
  return response.status(202).json({ accepted: true, message, room: developerRoomView() });
});

app.post("/api/actions", async (request, response) => {
  const action = request.body?.action as "ask" | "review" | "roundtable" | "continue";
  const target = request.body?.target as AgentId | "all" | "both";
  if (jobs.busy) return response.status(409).json({ error: "The room is already working." });
  if (!(["ask", "review", "roundtable", "continue"].includes(action))) {
    return response.status(400).json({ error: "Unknown room action." });
  }
  if (target !== "all" && target !== "both" && !isAgentId(target)) {
    return response.status(400).json({ error: "Unknown action target." });
  }

  const agents: AgentId[] = target === "all" || target === "both" ? AGENT_IDS : [target];
  jobs.enqueue(`action:${action}:${target}`, () => runJob(async () => {
    const turns = agents.map((agent) => ({
      agent,
      instruction: action === "continue"
        ? "Continue the latest unresolved room discussion. Focus on the specific open point, contribute only new substance, and help the group reach a usable conclusion. Use NO_RESPONSE_NEEDED if the matter is already settled."
        : action === "roundtable"
        ? "Join the discussion with the most useful opening thought. React to the room naturally and stop escalating once further replies would add noise."
        : action === "review"
          ? "Review the current worktree changes. Focus on correctness, clarity, security, accessibility, and missing tests. Report concrete findings before general observations."
          : "Read the room and contribute the most useful next thought.",
      includeDiff: action === "review",
    }));
    await performConversation(turns, action === "continue");
  }));
  return response.status(202).json({ accepted: true });
});

app.use(express.static(path.join(projectRoot, "dist")));
app.get("/{*splat}", (_request, response) => response.sendFile(path.join(projectRoot, "dist", "index.html")));

app.listen(port, host, () => {
  console.log(`AllMyFriendsAreAgents API listening on ${host}:${port}`);
  console.log(`Developer room bridge token: ${developerAccess.source}`);
});

import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONVERSATION_ENERGY_POLICIES, isConversationEnergy } from "../shared/conversation-energy.js";
import { AGENT_IDS, AGENT_PROFILES, isActiveAgentId, isAgentId, isParticipantId, normalizeWritableAgent } from "../shared/participants.js";
import { ROOM_PROTOCOL_VERSION } from "../shared/protocol.js";
import { cliAvailability, isAgentGenerationCancelledError, runAgent } from "./agent-runner.js";
import { AgentHealthRegistry } from "./agent-health.js";
import { deliverBurst } from "./burst-delivery.js";
import { conversationRandom, latestHumanInvitesWholeRoom, parseAgentTurn, rankRoomAgents, roomMessageTurns, runAgentConversation, runEnergyConversation, type ConversationTurn } from "./conversation.js";
import { CoordinatorHeartbeat, HttpDeveloperTeamExecutor, SqliteCoordinatorStateStore, coordinatorEnabled } from "./coordinator-heartbeat.js";
import { DeveloperBridgeService } from "./developer-bridge.js";
import { openDeveloperTeamRegistry } from "./developer-team.js";
import { GenerationJournal } from "./generation-journal.js";
import { HumanPresenceRegistry, humanPresenceAnnouncement, humanPresenceInstruction, type HumanPresenceEvent } from "./human-presence.js";
import { addHumanMessageOnce } from "./human-message.js";
import { CoalescingJobQueue } from "./job-queue.js";
import { pacingStartTime, responseDelayMs } from "./response-pacing.js";
import { projectPermissionAuditMessages, type ProjectPermissionActor } from "./project-permissions.js";
import { RoomActivity } from "./room-activity.js";
import { RoomEventStream } from "./room-event-stream.js";
import { publicRoomState, roomStateWithAvailability } from "./state-response.js";
import { resolveStorageConfiguration } from "./storage/config.js";
import { openRoomRepository } from "./storage/open-room-repository.js";
import { listWorkshopImprovements, readWorkshopImprovement } from "./workshop-api.js";
import type { AgentId, RoomSettings } from "./types.js";
import { projectParticipantImprovementManifest, resolveImprovementReferences } from "./governed-improvement-api.js";
import { roomMentionCandidates, validateMessageMentions } from "../shared/mentions.js";
import { AssignmentLifecycleService } from "./assignment-lifecycle.js";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDirectory, "..");
const port = Number(process.env.ALL_MY_FRIENDS_ARE_AGENTS_PORT || process.env.AGENTWIRE_PORT || 53147);
const host = process.env.ALL_MY_FRIENDS_ARE_AGENTS_HOST || "127.0.0.1";
const agentConcurrency = Math.max(1, Number.parseInt(process.env.ALL_MY_FRIENDS_ARE_AGENTS_AGENT_CONCURRENCY || "3", 10) || 3);
const serverIdentity = { instanceId: randomUUID(), protocolVersion: ROOM_PROTOCOL_VERSION };
let presenceConversationScheduled = false;
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
const agentHealth = await AgentHealthRegistry.open(storageConfiguration.dataDirectory);
const humans = new HumanPresenceRegistry();
const developerTeam = await openDeveloperTeamRegistry(storageConfiguration.dataDirectory);
const developerBridge = new DeveloperBridgeService(store, developerTeam);
const assignmentLifecycle = new AssignmentLifecycleService(
  store,
  store,
  developerTeam,
  store.snapshot().settings.projectPath,
  path.join(storageConfiguration.dataDirectory, "assignment-worktrees"),
);
await assignmentLifecycle.reconcile();
const coordinatorConfigured = coordinatorEnabled();
const coordinatorState = await SqliteCoordinatorStateStore.open(storageConfiguration.dataDirectory);
const coordinatorHeartbeat = new CoordinatorHeartbeat(
  store,
  coordinatorState,
  new HttpDeveloperTeamExecutor(
    process.env.ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_EXECUTOR_URL?.trim() || "http://127.0.0.1/heartbeat-disabled",
    process.env.ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_EXECUTOR_TOKEN
      ? `Bearer ${process.env.ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_EXECUTOR_TOKEN}`
      : undefined,
  ),
  {
    enabled: coordinatorConfigured,
    workerMemberId: process.env.ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_MEMBER_ID?.trim() || "coordinator",
    intervalMs: configuredPositiveInteger("ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_INTERVAL_MS"),
    leaseMs: configuredPositiveInteger("ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_LEASE_MS"),
    retryAfterMs: configuredPositiveInteger("ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_RETRY_AFTER_MS"),
    maxSelectedPerTick: configuredPositiveInteger("ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_MAX_SELECTED"),
    maxDispatchedPerTick: configuredPositiveInteger("ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_MAX_DISPATCHED"),
    maxAttempts: configuredPositiveInteger("ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_MAX_ATTEMPTS"),
    timeBudgetMs: configuredPositiveInteger("ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_TIME_BUDGET_MS"),
    onError: (error) => console.error("Coordinator heartbeat failed", error),
  },
);

app.use(express.json({ limit: "64kb" }));

function roomSnapshot() {
  return { ...store.snapshot(), humans: humans.list() };
}

function publicRoomSnapshot() {
  return { ...publicRoomState(roomSnapshot()), agentHealth: agentHealth.snapshot(), server: serverIdentity };
}

function broadcast() {
  roomEvents.broadcast(publicRoomSnapshot());
}

function developerRoomView(limit = 50) {
  const state = publicRoomSnapshot();
  const messages = state.messages.slice(-limit);
  return {
    ...state,
    messages,
    busy: jobs.busy,
    cursor: state.messages.at(-1)?.id,
    developerTeam: developerTeam.roster(),
  };
}

function sendBridgeResult(response: express.Response, result: { readonly kind: string; readonly [key: string]: unknown }) {
  if (result.kind === "ok") return response.json(result.value);
  if (result.kind === "unauthorized") return response.status(404).json({ error: "Not found." });
  if (result.kind === "not_found") return response.status(404).json({ error: "Improvement not found." });
  if (result.kind === "conflict") return response.status(409).json(result);
  return response.status(403).json(result);
}

async function performTurnUnchecked({ agent, instruction, includeDiff = false, visibleMessageLimit = 3 }: ConversationTurn) {
  const activeAgent = isActiveAgentId(agent) ? agent : undefined;
  if (activeAgent && !agentHealth.canAttempt(activeAgent)) return { failed: true };
  const before = roomSnapshot();
  const activityRevision = roomActivity.current();
  const pacingStartedAt = pacingStartTime(before.messages, agent, Date.now());
  const generationCancellation = roomActivity.abortSignal(activityRevision);
  let result;
  try {
    const assignmentWorkspace = includeDiff ? undefined : await assignmentLifecycle.workspaceForAgent(agent);
    result = await runAgent(agent, before, instruction, includeDiff, generationJournal, generationCancellation.signal, assignmentWorkspace);
  } catch (error) {
    if (isAgentGenerationCancelledError(error)) return { cancelled: true };
    if (!activeAgent) throw error;
    await agentHealth.recordFailure(activeAgent, error);
    console.error(`Agent command failed for ${agent}`, error);
    broadcast();
    return { failed: true };
  } finally {
    generationCancellation.dispose();
  }
  if (activeAgent && await agentHealth.recordSuccess(activeAgent)) broadcast();
  const permission = result.permission;
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
    await runEnergyConversation(turns, energy, performTurn, conversationRandom(snapshot), { inviteAll });
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
  if (presenceConversationScheduled) return;
  presenceConversationScheduled = true;
  const accepted = jobs.enqueue("presence-conversation", async () => {
    try {
      await runJob(async () => {
        const presenceState = roomSnapshot();
        const agent = rankRoomAgents(presenceState).find((candidate) => AGENT_PROFILES[candidate].provider !== "cursor");
        if (!agent) return;
        await performConversation([{
          agent,
          visibleMessageLimit: 1,
          instruction: humanPresenceInstruction(human.name, event),
        }], true);
      });
    } finally {
      presenceConversationScheduled = false;
    }
  });
  if (!accepted) presenceConversationScheduled = false;
}

app.get("/api/state", async (_request, response) => {
  response.json({ ...(await roomStateWithAvailability(roomSnapshot, cliAvailability)), agentHealth: agentHealth.snapshot(), server: serverIdentity });
});

app.get("/api/ready", (_request, response) => {
  response.set("Cache-Control", "no-store").json({ ready: true, ...serverIdentity });
});

// Room-facing workshop routes are intentionally read-only and project away
// developer credentials, manifests, fencing tokens, and private payloads.
app.get("/api/improvements", async (request, response) => {
  const requestedLimit = Number(request.query.limit || 20);
  const scope = request.query.scope === "all" ? "all" : "active";
  response.set("Cache-Control", "no-store").json(await listWorkshopImprovements(store, Number.isFinite(requestedLimit) ? requestedLimit : 20, scope));
});

app.post("/api/improvements/references", async (request, response) => {
  const text = request.body?.text;
  if (typeof text !== "string" || text.length > 16_000) {
    return response.status(400).json({ error: "Reference text must be a string of at most 16,000 characters." });
  }
  response.set("Cache-Control", "no-store").json(await resolveImprovementReferences(store, text));
});

app.post("/api/improvements/manifest", async (request, response) => {
  const text = request.body?.text;
  const addressedParticipants = Array.isArray(request.body?.addressedParticipants)
    ? request.body.addressedParticipants.filter(isParticipantId)
    : undefined;
  if (typeof text !== "string" || text.length > 16_000 || !addressedParticipants) {
    return response.status(400).json({ error: "Manifest projection requires bounded text and addressed participants." });
  }
  const explicitRetrievals = Array.isArray(request.body?.explicitRetrievals)
    ? request.body.explicitRetrievals.filter((entry: unknown): entry is { participantId: import("../shared/participants.js").ParticipantId; canonicalId: string } => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as Record<string, unknown>;
      return isParticipantId(value.participantId) && typeof value.canonicalId === "string" && value.canonicalId.length <= 120;
    })
    : [];
  response.set("Cache-Control", "no-store").json(await projectParticipantImprovementManifest(store, {
    interaction: { text, addressedParticipants },
    explicitRetrievals,
  }));
});

app.get("/api/improvements/:id", async (request, response) => {
  const view = await readWorkshopImprovement(store, request.params.id);
  if (!view) return response.status(404).json({ kind: "missing_item", canonicalId: request.params.id, error: "Improvement not found." });
  response.set("Cache-Control", "no-store").json(view);
});

app.get("/api/heartbeat", (_request, response) => {
  response.set("Cache-Control", "no-store").json({ configured: coordinatorConfigured, ...coordinatorHeartbeat.status() });
});

app.post("/api/heartbeat/authorize", (request, response) => {
  if (!coordinatorConfigured) return response.status(503).json({ error: "The bounded heartbeat executor is not configured." });
  const { expectedRevision, actorId, reason } = request.body ?? {};
  if (!Number.isSafeInteger(expectedRevision) || typeof actorId !== "string" || typeof reason !== "string") {
    return response.status(400).json({ error: "Expected revision, actor identity, and authorization reason are required." });
  }
  const runtime = coordinatorHeartbeat.authorize(expectedRevision, actorId, reason);
  if (!runtime) return response.status(409).json({ error: "Heartbeat state changed or authorization evidence was invalid.", runtime: coordinatorHeartbeat.status().runtime });
  response.json({ configured: true, ...coordinatorHeartbeat.status() });
});

app.post("/api/heartbeat/emergency-stop", (request, response) => {
  const { expectedRevision, actorId, reason } = request.body ?? {};
  if (!Number.isSafeInteger(expectedRevision) || typeof actorId !== "string" || typeof reason !== "string") {
    return response.status(400).json({ error: "Expected revision, actor identity, and stop reason are required." });
  }
  const runtime = coordinatorHeartbeat.emergencyStop(expectedRevision, actorId, reason);
  if (!runtime) return response.status(409).json({ error: "Heartbeat state changed or stop evidence was invalid.", runtime: coordinatorHeartbeat.status().runtime });
  response.json({ configured: coordinatorConfigured, ...coordinatorHeartbeat.status() });
});

app.get("/api/events", (request, response) => {
  const humanId = request.query.humanId;
  const connection = humans.connect(humanId);
  if (!connection) return response.status(400).json({ error: "Join the room before connecting." });
  roomEvents.connect(request, response, publicRoomSnapshot(), () => {
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
  const previousWritableAgent = store.snapshot().settings.writableAgent;
  let permissionActor: ProjectPermissionActor | undefined;
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
    const writableAgent = normalizeWritableAgent(update.writableAgent);
    if (writableAgent !== previousWritableAgent) {
      permissionActor = humans.get(request.body?.actorId);
      if (!permissionActor) return response.status(400).json({ error: "Join the room before changing project permissions." });
    }
    allowed.writableAgent = writableAgent;
  }
  if (isConversationEnergy(update.conversationEnergy)) {
    allowed.conversationEnergy = update.conversationEnergy;
  }
  if (Object.keys(allowed).length > 0) await store.updateSettings(allowed);
  if (allowed.writableAgent && permissionActor) {
    for (const text of projectPermissionAuditMessages(previousWritableAgent, allowed.writableAgent, permissionActor)) {
      await store.addMessage("system", text, "status", undefined, undefined, permissionActor);
    }
  }
  broadcast();
  response.json(publicRoomSnapshot());
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
  const clientMessageId = typeof request.body?.clientMessageId === "string" ? request.body.clientMessageId.trim() : "";
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(clientMessageId)) {
    return response.status(400).json({ error: "A valid client message ID is required." });
  }
  const duplicate = store.snapshot().messages.some((message) =>
    message.humanId === human.id && message.clientMessageId === clientMessageId
  );
  if (duplicate) return response.status(200).json(publicRoomSnapshot());
  let mentions;
  try {
    mentions = validateMessageMentions(request.body?.mentions, text, roomMentionCandidates(humans.list()));
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : "Message mentions are invalid." });
  }
  const accepted = await addHumanMessageOnce(store, human, text, clientMessageId, mentions);
  if (!accepted.inserted) return response.status(200).json(publicRoomSnapshot());
  roomActivity.interrupt();
  broadcast();

  jobs.enqueue("message-conversation", () => runJob(async () => {
    const conversationState = roomSnapshot();
    await performConversation(
      roomMessageTurns(conversationState),
      true,
      latestHumanInvitesWholeRoom(conversationState),
    );
  }));
  return response.status(202).json(publicRoomSnapshot());
});

app.get("/api/developer/room", (request, response) => {
  if (!developerTeam.authenticate(request.header("authorization"), "ROOM_READ")) return response.status(404).json({ error: "Not found." });
  const requestedLimit = Number(request.query.limit || 50);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, Math.floor(requestedLimit))) : 50;
  response.json(developerRoomView(limit));
});

app.post("/api/developer/messages", async (request, response) => {
  const authenticated = developerTeam.authenticate(request.header("authorization"), "ROOM_CHAT");
  if (!authenticated) return response.status(404).json({ error: "Not found." });
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  if (!text) return response.status(400).json({ error: "Message text is required." });
  if (text.length > 16_000) return response.status(400).json({ error: "Developer messages are limited to 16,000 characters." });

  roomActivity.interrupt();
  const message = await store.addMessage("you", text, "chat", undefined, undefined, {
    id: authenticated.member.memberId,
    name: authenticated.member.displayName,
  });
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

app.get("/api/developer/improvements/:id", async (request, response) => {
  return sendBridgeResult(response, await developerBridge.readImprovement(request.header("authorization"), request.params.id));
});

app.get("/api/developer/assignments", async (request, response) => {
  if (!developerTeam.authenticate(request.header("authorization"), "IMPROVEMENT_READ")) return response.status(404).json({ error: "Not found." });
  response.set("Cache-Control", "no-store").json({ metadata: assignmentLifecycle.metadata, assignments: await assignmentLifecycle.list() });
});

app.post("/api/developer/assignments", async (request, response) => {
  return sendBridgeResult(response, await assignmentLifecycle.create(request.header("authorization"), {
    assignmentId: request.body?.assignmentId,
    improvementId: request.body?.improvementId,
    agent: request.body?.agent,
    baseRef: request.body?.baseRef,
    fencingToken: request.body?.fencingToken,
    manifestRevision: request.body?.manifestRevision,
  }));
});

app.post("/api/developer/assignments/reconcile", async (request, response) => {
  if (!developerTeam.authenticate(request.header("authorization"), "ASSIGNMENT_WRITE")) return response.status(404).json({ error: "Not found." });
  response.json({ metadata: assignmentLifecycle.metadata, assignments: await assignmentLifecycle.reconcile() });
});

app.post("/api/developer/assignments/cleanup", async (request, response) => {
  if (!developerTeam.authenticate(request.header("authorization"), "ASSIGNMENT_WRITE")) return response.status(404).json({ error: "Not found." });
  response.json({ metadata: assignmentLifecycle.metadata, assignments: await assignmentLifecycle.cleanup() });
});

app.post("/api/developer/improvements/:id/claims", async (request, response) => {
  return sendBridgeResult(response, await developerBridge.acquireClaim(request.header("authorization"), {
    improvementId: request.params.id,
    expectedRevision: request.body?.expectedRevision,
    idempotencyKey: request.body?.idempotencyKey,
    leaseExpiresAt: request.body?.leaseExpiresAt,
    manifest: request.body?.manifest,
  }));
});

app.get("/api/developer/improvements/:id/claims", async (request, response) => {
  return sendBridgeResult(response, await developerBridge.readClaim(request.header("authorization"), request.params.id));
});

app.post("/api/developer/improvements/:id/claims/:operation", async (request, response) => {
  return sendBridgeResult(response, await developerBridge.mutateClaim(request.header("authorization"), {
    improvementId: request.params.id,
    expectedRevision: request.body?.expectedRevision,
    idempotencyKey: request.body?.idempotencyKey,
    fencingToken: request.body?.fencingToken,
    operation: request.params.operation as "renew" | "release" | "expire" | "complete" | "manifest" | "handoff",
    leaseExpiresAt: request.body?.leaseExpiresAt,
    toMemberId: request.body?.toMemberId,
    manifest: request.body?.manifest,
  }));
});

app.post("/api/developer/improvements/:id/evidence", async (request, response) => {
  return sendBridgeResult(response, await developerBridge.appendEvidence(request.header("authorization"), {
    improvementId: request.params.id,
    expectedRevision: request.body?.expectedRevision,
    fencingToken: request.body?.fencingToken,
    evidence: request.body?.evidence,
  }));
});

app.post("/api/developer/improvements/:id/reviews", async (request, response) => {
  return sendBridgeResult(response, await developerBridge.recordReview(request.header("authorization"), {
    improvementId: request.params.id,
    expectedRevision: request.body?.expectedRevision,
    decision: request.body?.decision,
  }));
});

app.post("/api/developer/improvements/:id/transitions", async (request, response) => {
  return sendBridgeResult(response, await developerBridge.requestTransition(request.header("authorization"), {
    improvementId: request.params.id,
    expectedRevision: request.body?.expectedRevision,
    fencingToken: request.body?.fencingToken,
    to: request.body?.to,
    action: request.body?.action,
  }));
});

app.post("/api/actions", async (request, response) => {
  const action = request.body?.action as "ask" | "review" | "roundtable" | "continue";
  const target = request.body?.target as AgentId | "all" | "both";
  if (jobs.busy) return response.status(409).json({ error: "The room is already working." });
  if (!(["ask", "review", "roundtable", "continue"].includes(action))) {
    return response.status(400).json({ error: "Unknown room action." });
  }
  if (target !== "all" && target !== "both" && !isActiveAgentId(target)) {
    return response.status(400).json({ error: "Unknown action target." });
  }

  const agents: AgentId[] = target === "all" || target === "both" ? [...AGENT_IDS] : [target];
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

const httpServer = app.listen(port, host, () => {
  console.log(`AllMyFriendsAreAgents API listening on ${host}:${port}`);
  console.log(`Developer team bridge: ${developerTeam.roster().length} configured member(s)`);
});

if (coordinatorHeartbeat.start()) {
  console.log("Bounded coordinator heartbeat enabled");
}

function configuredPositiveInteger(name: string) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  coordinatorHeartbeat.close();
  httpServer.close((error) => {
    if (error) {
      console.error(`Server shutdown after ${signal} failed`, error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

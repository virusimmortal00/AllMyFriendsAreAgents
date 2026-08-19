import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Response } from "express";
import { sanitizeChatStyle } from "../shared/chat-style.js";
import { cliAvailability, runAgent } from "./agent-runner.js";
import { parseAgentTurn, roomMessageTurns, runAgentConversation, type ConversationTurn } from "./conversation.js";
import { RoomStore } from "./room-store.js";
import type { AgentId, RoomSettings } from "./types.js";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDirectory, "..");
const port = Number(process.env.ALL_MY_FRIENDS_ARE_AGENTS_PORT || process.env.AGENTWIRE_PORT || 4174);
const app = express();
const store = await RoomStore.open(projectRoot);
const clients = new Set<Response>();
let activeJob = false;

app.use(express.json({ limit: "64kb" }));

function broadcast() {
  const event = `data: ${JSON.stringify(store.snapshot())}\n\n`;
  for (const client of clients) client.write(event);
}

async function performTurn({ agent, instruction, includeDiff = false }: ConversationTurn) {
  const before = store.snapshot();
  const result = await runAgent(agent, before, instruction, includeDiff);
  const permission = includeDiff || before.settings.writableAgent !== agent ? "read-only" : "writable";
  await store.setSession(agent, result.sessionId, permission);
  const currentStyle = before.settings.participantStyles[agent];
  const parsed = parseAgentTurn(agent, result.text, currentStyle);
  if (parsed.styleUpdate) await store.updateParticipantStyle(agent, parsed.styleUpdate);
  if (parsed.visibleText) {
    await store.addMessage(agent, parsed.visibleText, includeDiff ? "review" : "chat", parsed.styleUpdate || currentStyle);
  }
  broadcast();
  return { replyCandidate: parsed.replyCandidate, mentionedAgent: parsed.mentionedAgent };
}

async function performConversation(turns: ConversationTurn[]) {
  const maxFollowUps = store.snapshot().settings.maxRounds;
  await store.setStatus("working", turns.length === 1 ? turns[0].agent : undefined);
  broadcast();
  await runAgentConversation(turns, maxFollowUps, performTurn);
}

async function runJob(job: () => Promise<void>) {
  activeJob = true;
  try {
    await job();
    await store.setStatus("idle");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.addMessage("system", `Agent error: ${message}`, "status");
    await store.setStatus("error", undefined, message);
  } finally {
    activeJob = false;
    broadcast();
  }
}

app.get("/api/state", async (_request, response) => {
  response.json({ ...store.snapshot(), availability: await cliAvailability() });
});

app.get("/api/events", (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  clients.add(response);
  response.write(`data: ${JSON.stringify(store.snapshot())}\n\n`);
  request.on("close", () => clients.delete(response));
});

app.patch("/api/settings", async (request, response) => {
  const update = request.body as Partial<RoomSettings>;
  const allowed: Partial<RoomSettings> = {};
  if (["codex", "claude", "nobody"].includes(update.writableAgent || "")) {
    allowed.writableAgent = update.writableAgent;
  }
  if (Number.isInteger(update.maxRounds) && Number(update.maxRounds) >= 1 && Number(update.maxRounds) <= 8) {
    allowed.maxRounds = Number(update.maxRounds);
  }
  await store.updateSettings(allowed);
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
  if (activeJob) return response.status(409).json({ error: "The room is already working." });

  await store.addMessage("you", text, "chat", store.snapshot().settings.participantStyles.you);
  broadcast();

  void runJob(async () => {
    await performConversation(roomMessageTurns());
  });
  return response.status(202).json({ accepted: true });
});

app.post("/api/actions", async (request, response) => {
  const action = request.body?.action as "ask" | "review" | "roundtable";
  const target = request.body?.target as AgentId | "both";
  if (activeJob) return response.status(409).json({ error: "The room is already working." });
  if (!(["ask", "review", "roundtable"].includes(action))) {
    return response.status(400).json({ error: "Unknown room action." });
  }
  if (!["codex", "claude", "both"].includes(target)) {
    return response.status(400).json({ error: "Unknown action target." });
  }

  const agents: AgentId[] = target === "both" ? ["codex", "claude"] : [target];
  void runJob(async () => {
    await performConversation(agents.map((agent) => ({
      agent,
      instruction: action === "roundtable"
        ? "Join the discussion with the most useful opening thought. React to the room naturally and stop escalating once further replies would add noise."
        : action === "review"
          ? "Review the current worktree changes. Focus on correctness, clarity, security, accessibility, and missing tests. Report concrete findings before general observations."
          : "Read the room and contribute the most useful next thought.",
      includeDiff: action === "review",
    })));
  });
  return response.status(202).json({ accepted: true });
});

app.use(express.static(path.join(projectRoot, "dist")));
app.get("/{*splat}", (_request, response) => response.sendFile(path.join(projectRoot, "dist", "index.html")));

app.listen(port, "127.0.0.1", () => {
  console.log(`AllMyFriendsAreAgents API listening at http://127.0.0.1:${port}`);
});

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Response } from "express";
import { cliAvailability, runAgent } from "./agent-runner.js";
import { RoomStore } from "./room-store.js";
import type { AgentId, RoomSettings } from "./types.js";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDirectory, "..");
const port = Number(process.env.AGENTWIRE_PORT || 4174);
const app = express();
const store = await RoomStore.open(projectRoot);
const clients = new Set<Response>();
let activeJob = false;

app.use(express.json({ limit: "64kb" }));

function broadcast() {
  const event = `data: ${JSON.stringify(store.snapshot())}\n\n`;
  for (const client of clients) client.write(event);
}

async function performTurn(agent: AgentId, instruction: string, includeDiff = false) {
  await store.setStatus("working", agent);
  broadcast();
  const before = store.snapshot();
  const result = await runAgent(agent, before, instruction, includeDiff);
  const permission = before.settings.writableAgent === agent ? "writable" : "read-only";
  await store.setSession(agent, result.sessionId, permission);
  await store.addMessage(agent, result.text, includeDiff ? "review" : "chat");
  broadcast();
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

app.post("/api/messages", async (request, response) => {
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  const target = request.body?.target as AgentId | "both" | "everyone";
  if (!text) return response.status(400).json({ error: "Message text is required." });
  if (!["codex", "claude", "both", "everyone"].includes(target)) {
    return response.status(400).json({ error: "Unknown message target." });
  }
  if (activeJob) return response.status(409).json({ error: "The room is already working." });

  await store.addMessage("you", text);
  broadcast();
  if (target === "everyone") return response.status(201).json(store.snapshot());

  const agents: AgentId[] = target === "both" ? ["codex", "claude"] : [target];
  void runJob(async () => {
    for (const agent of agents) await performTurn(agent, "Respond to the latest human message and the current room discussion.");
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
    if (action === "roundtable") {
      const rounds = store.snapshot().settings.maxRounds;
      for (let index = 0; index < rounds; index += 1) {
        const agent = index % 2 === 0 ? "codex" : "claude";
        await performTurn(agent, "Continue the discussion by responding to the other participants. Stop escalating if consensus is clear.");
      }
      return;
    }
    for (const agent of agents) {
      await performTurn(
        agent,
        action === "review"
          ? "Review the current worktree changes. Focus on correctness, clarity, security, accessibility, and missing tests. Report concrete findings before general observations."
          : "Read the room and contribute the most useful next thought.",
        action === "review",
      );
    }
  });
  return response.status(202).json({ accepted: true });
});

app.use(express.static(path.join(projectRoot, "dist")));
app.get("/{*splat}", (_request, response) => response.sendFile(path.join(projectRoot, "dist", "index.html")));

app.listen(port, "127.0.0.1", () => {
  console.log(`AgentWire 98 API listening at http://127.0.0.1:${port}`);
});

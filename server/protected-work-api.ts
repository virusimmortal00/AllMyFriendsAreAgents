import type express from "express";
import { z } from "zod";
import { isAgentId } from "../shared/participants.js";
import type { AgentId } from "../shared/participants.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import { sessionHuman, type HumanSessions } from "./human-session.js";
import type { HumanPresenceRegistry } from "./human-presence.js";
import type { ProtectedWorkService } from "./protected-work-service.js";

const identity = z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const startSchema = z.object({ roomId: z.string(), owner: z.string().refine(isAgentId), objective: z.string().trim().min(1).max(4_000), requestId: identity }).strict();
const actionSchema = z.object({ roomId: z.string(), requestId: identity }).strict();
export function registerProtectedWorkRoutes(input: {
  app: express.Express; roomId: string; service: ProtectedWorkService; humans: HumanPresenceRegistry;
  sessions: HumanSessions; developers: DeveloperTeamRegistry; member?: (humanId: string) => boolean | Promise<boolean>;
}) {
  const actor = async (request: express.Request, write: boolean) => {
    const human = sessionHuman(request, input.humans, input.sessions);
    if (human && (!input.member || await input.member(human.id))) return `human:${human.id}`;
    const developer = input.developers.authenticate(request.header("authorization"), write ? "COMMAND_RUN" : "ROOM_READ");
    return developer ? `developer:${developer.member.memberId}` : undefined;
  };
  input.app.get("/api/protected-work", async (request, response) => {
    if (!await actor(request, false) || request.query.roomId !== input.roomId) return response.status(404).json({ error: "Not found." });
    return response.set("Cache-Control", "no-store").json(await input.service.list());
  });
  input.app.post("/api/protected-work", async (request, response) => {
    const authenticated = await actor(request, true);
    if (!authenticated) return response.status(404).json({ error: "Not found." });
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.roomId !== input.roomId) return response.status(400).json({ error: "An explicit room, participant, bounded objective, and request ID are required." });
    try { return response.status(202).json(await input.service.start({ ...parsed.data, owner: parsed.data.owner as AgentId }, authenticated)); }
    catch (error) { return response.status(409).json({ error: error instanceof Error ? error.message : "Protected work unavailable." }); }
  });
  input.app.post("/api/protected-work/:id/:action", async (request, response) => {
    const authenticated = await actor(request, true);
    if (!authenticated) return response.status(404).json({ error: "Not found." });
    const parsed = actionSchema.safeParse(request.body);
    const action = String(request.params.action);
    if (!parsed.success || parsed.data.roomId !== input.roomId || !["stop", "retry-return", "dismiss"].includes(action)) return response.status(400).json({ error: "An explicit room, request ID, and supported operation are required." });
    try { return response.json(await input.service.action(String(request.params.id), action as "stop" | "retry-return" | "dismiss", { actor: authenticated, id: parsed.data.requestId })); }
    catch (error) { return response.status(409).json({ error: error instanceof Error ? error.message : "Protected work unavailable." }); }
  });
}

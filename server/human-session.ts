import { randomUUID } from "node:crypto";
import type express from "express";
import type { HumanPresenceRegistry } from "./human-presence.js";

export const HUMAN_SESSION_COOKIE = "amfaa_human_session";

export class HumanSessions {
  private readonly sessions = new Map<string, string>();

  issue(humanId: string) {
    for (const [token, existing] of this.sessions) if (existing === humanId) return token;
    const token = randomUUID();
    this.sessions.set(token, humanId);
    return token;
  }

  humanId(cookieHeader?: string) {
    const encoded = cookieHeader?.split(";")
      .map((part) => part.trim().split("="))
      .find(([name]) => name === HUMAN_SESSION_COOKIE)?.[1];
    if (!encoded) return undefined;
    try {
      return this.sessions.get(decodeURIComponent(encoded));
    } catch {
      return undefined;
    }
  }
}

export function setHumanSession(response: express.Response, sessions: HumanSessions, humanId: string) {
  response.setHeader("Set-Cookie", `${HUMAN_SESSION_COOKIE}=${encodeURIComponent(sessions.issue(humanId))}; Path=/api; HttpOnly; SameSite=Strict`);
}

export function sessionHuman(request: express.Request, humans: HumanPresenceRegistry, sessions: HumanSessions) {
  const id = sessions.humanId(request.header("cookie"));
  return id ? humans.get(id) : undefined;
}

/** A client may resume only the identity already bound to its opaque server session. */
export function joinHumanWithSession(request: express.Request, response: express.Response, humans: HumanPresenceRegistry, sessions: HumanSessions) {
  const sessionHumanId = sessions.humanId(request.header("cookie"));
  const human = humans.join({ name: request.body?.name, style: request.body?.style, avatarUrl: request.body?.avatarUrl }, sessionHumanId);
  setHumanSession(response, sessions, human.id);
  return human;
}

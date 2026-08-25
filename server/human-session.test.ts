import express from "express";
import { describe, expect, it } from "vitest";
import { HumanPresenceRegistry } from "./human-presence.js";
import { HUMAN_SESSION_COOKIE, HumanSessions, joinHumanWithSession, sessionHuman } from "./human-session.js";

function request(body: unknown, cookie?: string) {
  return {
    body,
    header: (name: string) => name.toLowerCase() === "cookie" ? cookie : undefined,
  } as express.Request;
}

function response() {
  const headers = new Map<string, string>();
  return {
    headers,
    value: { setHeader: (name: string, value: string) => headers.set(name, value) } as unknown as express.Response,
  };
}

describe("human sessions", () => {
  it("ignores a caller-supplied participant ID and binds a new opaque session", () => {
    const humans = new HumanPresenceRegistry();
    const sessions = new HumanSessions();
    const victim = humans.join({ name: "Same name" });
    const target = response();

    const joined = joinHumanWithSession(request({ id: victim.id, name: "Same name" }), target.value, humans, sessions);

    expect(joined.id).not.toBe(victim.id);
    expect(joined.name).toBe(victim.name);
    expect(target.headers.get("Set-Cookie")).toMatch(new RegExp(`^${HUMAN_SESSION_COOKIE}=.+; Path=/api; HttpOnly; SameSite=Strict$`));
  });

  it("resumes only the identity bound to the cookie and keeps another human's style isolated", () => {
    const humans = new HumanPresenceRegistry();
    const sessions = new HumanSessions();
    const firstResponse = response();
    const first = joinHumanWithSession(request({ name: "Alex", style: { textColor: "#3074fd" } }), firstResponse.value, humans, sessions);
    const cookie = firstResponse.headers.get("Set-Cookie")!.split(";")[0];
    const other = humans.join({ name: "Alex", style: { textColor: "#ec301a" } });
    const resumedResponse = response();

    const resumed = joinHumanWithSession(request({ id: other.id, name: "Alex", style: first.style }, cookie), resumedResponse.value, humans, sessions);

    expect(resumed.id).toBe(first.id);
    expect(resumed.id).not.toBe(other.id);
    expect(humans.get(other.id)?.style.textColor).toBe("#ec301a");
    expect(sessionHuman(request({}, cookie), humans, sessions)?.id).toBe(first.id);
  });

  it("rejects missing, unknown, and malformed session cookies without resolving a human", () => {
    const humans = new HumanPresenceRegistry();
    const sessions = new HumanSessions();
    humans.join({ name: "Ada" });

    expect(sessionHuman(request({}), humans, sessions)).toBeUndefined();
    expect(sessionHuman(request({}, `${HUMAN_SESSION_COOKIE}=unknown`), humans, sessions)).toBeUndefined();
    expect(sessionHuman(request({}, `${HUMAN_SESSION_COOKIE}=%E0%A4%A`), humans, sessions)).toBeUndefined();
  });
});

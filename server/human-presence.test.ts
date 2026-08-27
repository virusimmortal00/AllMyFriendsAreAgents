import { afterEach, describe, expect, it, vi } from "vitest";
import { HUMAN_DEPARTURE_GRACE_MS, HumanPresenceAnnouncements, HumanPresenceRegistry, humanPresenceAnnouncement, humanPresenceInstruction } from "./human-presence.js";

afterEach(() => vi.useRealTimers());

describe("HumanPresenceRegistry", () => {
  it("tracks distinct named humans and only lists connected participants", () => {
    const humans = new HumanPresenceRegistry();
    const alice = humans.join({ name: " Alice " });
    const bob = humans.join({ name: "Bob" });

    expect(humans.connect(alice.id)?.becamePresent).toBe(true);
    expect(humans.connect(bob.id)?.becamePresent).toBe(true);
    expect(humans.list().map(({ name }) => name)).toEqual(["Alice", "Bob"]);

    expect(humans.disconnect(alice.id)?.becameAbsent).toBe(true);
    expect(humans.list().map(({ name }) => name)).toEqual(["Bob"]);
  });

  it("keeps one human present while another tab with the same identity remains connected", () => {
    const humans = new HumanPresenceRegistry();
    const alice = humans.join({ name: "Alice" });
    expect(humans.connect(alice.id)?.becamePresent).toBe(true);
    expect(humans.connect(alice.id)?.becamePresent).toBe(false);

    expect(humans.disconnect(alice.id)?.becameAbsent).toBe(false);
    expect(humans.list().map(({ name }) => name)).toEqual(["Alice"]);
    expect(humans.disconnect(alice.id)?.becameAbsent).toBe(true);
    expect(humans.list()).toEqual([]);
  });

  it("reuses a browser identity after reconnect and keeps styles separate", () => {
    const humans = new HumanPresenceRegistry();
    const alice = humans.join({ name: "Alice" });
    const updated = humans.updateStyle(alice.id, { textColor: "#ed36ff" });
    const rejoined = humans.join({ name: "Alice", style: updated?.style }, alice.id);

    expect(rejoined.id).toBe(alice.id);
    expect(rejoined.style.textColor).toBe("#ed36ff");
  });

  it("keeps a validated profile photo with the human identity and can remove it", () => {
    const humans = new HumanPresenceRegistry();
    const avatarUrl = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64")}`;
    const alice = humans.join({ name: "Alice", avatarUrl });

    expect(alice.avatarUrl).toBe(avatarUrl);
    expect(humans.join({ name: "Alice" }, alice.id).avatarUrl).toBe(avatarUrl);
    expect(humans.join({ name: "Grace Hopper", avatarUrl: null }, alice.id)).toMatchObject({ id: alice.id, name: "Grace Hopper" });
    expect(humans.get(alice.id)).not.toHaveProperty("avatarUrl");
    expect(humans.updateAvatar(alice.id, undefined)).not.toHaveProperty("avatarUrl");
    expect(humans.join({ name: "Alice", avatarUrl: "https://example.com/tracker.png" }, alice.id)).not.toHaveProperty("avatarUrl");
  });

  it("rejects blank names", () => {
    const humans = new HumanPresenceRegistry();
    expect(() => humans.join({ name: "   " })).toThrow("Your name is required.");
  });

  it("formats durable announcements and explicitly optional agent opportunities", () => {
    expect(humanPresenceAnnouncement("Alice", "joined")).toBe("Alice has joined the chat");
    expect(humanPresenceAnnouncement("Alice", "left")).toBe("Alice has left the chat");
    expect(humanPresenceInstruction("Alice", "joined")).toContain("optional chance to greet");
    expect(humanPresenceInstruction("Alice", "joined")).toContain("TURN_DISPOSITION");
    expect(humanPresenceInstruction("Alice", "left")).toContain("Do not address them as if they are still present");
  });

  it("keeps live presence immediate while suppressing a refresh departure and matching arrival", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const humans = new HumanPresenceRegistry();
    const announcements = new HumanPresenceAnnouncements(async (human, event) => { events.push(`${human.id}:${event}`); });
    const alice = humans.join({ name: "Alice" });
    const firstConnection = humans.connect(alice.id)!;
    announcements.arrival(firstConnection.human, firstConnection.becamePresent);

    const disconnected = humans.disconnect(alice.id)!;
    announcements.departure(disconnected.human, disconnected.becameAbsent);
    expect(humans.list()).toEqual([]);
    expect(events).toEqual([`${alice.id}:joined`]);

    const resumed = humans.join({ name: "Alice" }, alice.id);
    const reconnected = humans.connect(resumed.id)!;
    expect(announcements.arrival(reconnected.human, reconnected.becamePresent)).toBe(true);
    await vi.advanceTimersByTimeAsync(HUMAN_DEPARTURE_GRACE_MS);

    expect(humans.list().map(({ id }) => id)).toEqual([alice.id]);
    expect(events).toEqual([`${alice.id}:joined`]);
  });

  it("durably announces a genuine departure only after the grace period", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const humans = new HumanPresenceRegistry();
    const announcements = new HumanPresenceAnnouncements(async (_human, event) => { events.push(event); });
    const alice = humans.join({ name: "Alice" });
    const connected = humans.connect(alice.id)!;
    announcements.arrival(connected.human, connected.becamePresent);
    const disconnected = humans.disconnect(alice.id)!;
    announcements.departure(disconnected.human, disconnected.becameAbsent);

    await vi.advanceTimersByTimeAsync(HUMAN_DEPARTURE_GRACE_MS - 1);
    expect(events).toEqual(["joined"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["joined", "left"]);
  });

  it("waits for the final tab and cancels that departure when another tab reconnects", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const humans = new HumanPresenceRegistry();
    const announcements = new HumanPresenceAnnouncements(async (_human, event) => { events.push(event); });
    const alice = humans.join({ name: "Alice" });
    const first = humans.connect(alice.id)!;
    announcements.arrival(first.human, first.becamePresent);
    humans.connect(alice.id);

    const oneTabClosed = humans.disconnect(alice.id)!;
    announcements.departure(oneTabClosed.human, oneTabClosed.becameAbsent);
    await vi.advanceTimersByTimeAsync(HUMAN_DEPARTURE_GRACE_MS);
    expect(events).toEqual(["joined"]);

    const lastTabClosed = humans.disconnect(alice.id)!;
    announcements.departure(lastTabClosed.human, lastTabClosed.becameAbsent);
    const replacementTab = humans.connect(alice.id)!;
    announcements.arrival(replacementTab.human, replacementTab.becamePresent);
    await vi.advanceTimersByTimeAsync(HUMAN_DEPARTURE_GRACE_MS);
    expect(events).toEqual(["joined"]);
  });

  it("does not let a different identity cancel a pending departure, even with the same name", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const humans = new HumanPresenceRegistry();
    const announcements = new HumanPresenceAnnouncements(async (human, event) => { events.push(`${human.id}:${event}`); });
    const alice = humans.join({ name: "Alex" });
    const connected = humans.connect(alice.id)!;
    announcements.arrival(connected.human, connected.becamePresent);
    const disconnected = humans.disconnect(alice.id)!;
    announcements.departure(disconnected.human, disconnected.becameAbsent);

    const other = humans.join({ name: "Alex" });
    const otherConnection = humans.connect(other.id)!;
    expect(announcements.arrival(otherConnection.human, otherConnection.becamePresent)).toBe(false);
    await vi.advanceTimersByTimeAsync(HUMAN_DEPARTURE_GRACE_MS);

    expect(events).toEqual([`${alice.id}:joined`, `${other.id}:joined`, `${alice.id}:left`]);
  });

  it("drops pending departures during planned shutdown", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const humans = new HumanPresenceRegistry();
    const announcements = new HumanPresenceAnnouncements(async (_human, event) => { events.push(event); });
    const alice = humans.join({ name: "Alice" });
    humans.connect(alice.id);
    const disconnected = humans.disconnect(alice.id)!;
    announcements.departure(disconnected.human, disconnected.becameAbsent);

    expect(announcements.shutdown()).toBe(1);
    await vi.advanceTimersByTimeAsync(HUMAN_DEPARTURE_GRACE_MS);
    expect(events).toEqual([]);
  });
});

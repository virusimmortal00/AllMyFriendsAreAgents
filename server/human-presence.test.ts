import { describe, expect, it } from "vitest";
import { HumanPresenceRegistry, humanPresenceAnnouncement, humanPresenceInstruction } from "./human-presence.js";

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

  it("rejects blank names", () => {
    const humans = new HumanPresenceRegistry();
    expect(() => humans.join({ name: "   " })).toThrow("Your name is required.");
  });

  it("formats durable announcements and explicitly optional agent opportunities", () => {
    expect(humanPresenceAnnouncement("Alice", "joined")).toBe("Alice has joined the chat");
    expect(humanPresenceAnnouncement("Alice", "left")).toBe("Alice has left the chat");
    expect(humanPresenceInstruction("Alice", "joined")).toContain("optional chance to greet");
    expect(humanPresenceInstruction("Alice", "joined")).toContain("NO_RESPONSE_NEEDED");
    expect(humanPresenceInstruction("Alice", "left")).toContain("Do not address them as if they are still present");
  });
});

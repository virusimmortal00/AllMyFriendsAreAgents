import { describe, expect, it } from "vitest";
import { validHumanAvatarDataUrl } from "./human-avatar.js";

describe("human avatar validation", () => {
  it("accepts supported image signatures and rejects active or malformed payloads", () => {
    expect(validHumanAvatarDataUrl(`data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64")}`)).toBe(true);
    expect(validHumanAvatarDataUrl(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`)).toBe(true);
    expect(validHumanAvatarDataUrl(`data:image/webp;base64,${Buffer.from("RIFF0000WEBP").toString("base64")}`)).toBe(true);
    expect(validHumanAvatarDataUrl(`data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`)).toBe(false);
    expect(validHumanAvatarDataUrl("https://example.com/tracker.png")).toBe(false);
  });
});

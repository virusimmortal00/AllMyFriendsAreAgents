import { describe, expect, it } from "vitest";
import { providerMarkProps } from "./provider-mark";

describe("provider mark properties", () => {
  it("omits unknown identities instead of serializing undefined values", () => {
    expect(providerMarkProps(undefined, undefined)).toEqual({});
    expect(providerMarkProps("google", undefined, true)).toEqual({ authorId: "google", compact: true });
    expect(providerMarkProps("google", "openrouter")).toEqual({
      authorId: "google",
      accessProviderId: "openrouter",
    });
  });
});

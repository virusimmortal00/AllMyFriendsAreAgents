import { describe, expect, it } from "vitest";
import { reconnectDelayMs, restoreScrollDistance, scrollDistanceFromBottom } from "./reconnect";

describe("reconnect policy", () => {
  it("uses capped exponential backoff with jitter", () => {
    expect(reconnectDelayMs(0, () => 0.5)).toBe(750);
    expect(reconnectDelayMs(3, () => 0.5)).toBe(6_000);
    expect(reconnectDelayMs(20, () => 0.5)).toBe(15_000);
  });

  it("restores the prior distance from the transcript bottom", () => {
    const element = { scrollHeight: 1_000, clientHeight: 300, scrollTop: 500 };
    const distance = scrollDistanceFromBottom(element);
    element.scrollHeight = 1_200;
    restoreScrollDistance(element, distance);
    expect(element.scrollTop).toBe(700);
  });
});

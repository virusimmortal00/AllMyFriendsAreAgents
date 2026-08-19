import { describe, expect, it, vi } from "vitest";
import { scrollTranscriptToEnd } from "./scroll";

describe("scrollTranscriptToEnd", () => {
  it("never returns the browser scroll result as an effect cleanup", () => {
    const scrollIntoView = vi.fn(() => Promise.resolve());
    const element = { scrollIntoView } as unknown as HTMLDivElement;

    expect(scrollTranscriptToEnd(element)).toBeUndefined();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth" });
  });
});


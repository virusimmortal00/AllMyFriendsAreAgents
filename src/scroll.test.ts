import { describe, expect, it, vi } from "vitest";
import { scrollTranscriptToEnd } from "./scroll";

describe("scrollTranscriptToEnd", () => {
  it("scrolls the transcript container to its full content height", () => {
    const scrollTo = vi.fn(() => Promise.resolve());
    const transcript = { scrollHeight: 987, scrollTo } as unknown as HTMLDivElement;

    expect(scrollTranscriptToEnd(transcript)).toBeUndefined();
    expect(scrollTo).toHaveBeenCalledWith({ top: 987, behavior: "smooth" });
  });
});

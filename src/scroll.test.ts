import { describe, expect, it, vi } from "vitest";
import { scrollTranscriptToEnd } from "./scroll";

describe("scrollTranscriptToEnd", () => {
  it("scrolls the transcript container to its full content height", () => {
    const scrollTo = vi.fn(() => Promise.resolve());
    const transcript = { scrollHeight: 987, scrollTo } as unknown as HTMLDivElement;

    expect(scrollTranscriptToEnd(transcript)).toBeUndefined();
    expect(scrollTo).toHaveBeenCalledWith({ top: 987, behavior: "smooth" });
  });

  it("can position initial history instantly before the room is revealed", () => {
    const scrollTo = vi.fn(() => Promise.resolve());
    const transcript = { scrollHeight: 654, scrollTo } as unknown as HTMLDivElement;

    scrollTranscriptToEnd(transcript, "auto");

    expect(scrollTo).toHaveBeenCalledWith({ top: 654, behavior: "auto" });
  });
});

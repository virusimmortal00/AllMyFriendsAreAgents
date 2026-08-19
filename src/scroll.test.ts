import { describe, expect, it, vi } from "vitest";
import { scrollTranscriptToEnd } from "./scroll";

describe("scrollTranscriptToEnd", () => {
  it("scrolls the transcript container to its full content height", () => {
    const scrollTo = vi.fn(() => Promise.resolve());
    const transcript = { scrollHeight: 987, scrollTo, style: { scrollBehavior: "" } } as unknown as HTMLDivElement;

    expect(scrollTranscriptToEnd(transcript)).toBeUndefined();
    expect(scrollTo).toHaveBeenCalledWith({ top: 987, behavior: "smooth" });
  });

  it("suppresses inherited smooth scrolling while positioning initial history", () => {
    const calls: Array<{ behaviorDuringCall: string; options: ScrollToOptions }> = [];
    const style = { scrollBehavior: "smooth" };
    const transcript = {
      scrollHeight: 654,
      style,
      scrollTo(options: ScrollToOptions) {
        calls.push({ behaviorDuringCall: style.scrollBehavior, options });
      },
    } as unknown as HTMLDivElement;

    scrollTranscriptToEnd(transcript, "auto");

    expect(calls).toEqual([{
      behaviorDuringCall: "auto",
      options: { top: 654, behavior: "auto" },
    }]);
    expect(transcript.style.scrollBehavior).toBe("smooth");
  });
});

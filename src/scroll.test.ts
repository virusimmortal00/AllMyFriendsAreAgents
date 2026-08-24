// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { isTranscriptFollowing, preferredScrollBehavior, scrollTranscriptToEnd, transcriptDistanceFromEnd } from "./scroll";

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

  it("measures follow state from the rendered viewport instead of message counts", () => {
    const transcript = { scrollHeight: 1_200, clientHeight: 300, scrollTop: 868 };
    expect(transcriptDistanceFromEnd(transcript)).toBe(32);
    expect(isTranscriptFollowing(transcript)).toBe(true);
    transcript.scrollTop = 867;
    expect(isTranscriptFollowing(transcript)).toBe(false);
  });

  it("removes nonessential scroll motion when the user prefers reduced motion", () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    expect(preferredScrollBehavior()).toBe("auto");
    matchMedia.mockReturnValue({ matches: false } as MediaQueryList);
    expect(preferredScrollBehavior()).toBe("smooth");
    matchMedia.mockRestore();
  });
});

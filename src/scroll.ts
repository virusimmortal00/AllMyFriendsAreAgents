export function scrollTranscriptToEnd(transcript: HTMLDivElement | null, behavior: ScrollBehavior = "smooth"): void {
  if (!transcript) return;

  if (typeof transcript.scrollTo !== "function") {
    transcript.scrollTop = transcript.scrollHeight;
    return;
  }

  if (behavior === "auto") {
    const previousScrollBehavior = transcript.style.scrollBehavior;
    transcript.style.scrollBehavior = "auto";
    transcript.scrollTo({ top: transcript.scrollHeight, behavior });
    transcript.style.scrollBehavior = previousScrollBehavior;
    return;
  }

  transcript.scrollTo({ top: transcript.scrollHeight, behavior });
}

export const TRANSCRIPT_FOLLOW_THRESHOLD_PX = 32;

type ScrollMetrics = Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTop">;

export function transcriptDistanceFromEnd(transcript: ScrollMetrics): number {
  return Math.max(0, transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop);
}

export function isTranscriptFollowing(transcript: ScrollMetrics, threshold = TRANSCRIPT_FOLLOW_THRESHOLD_PX): boolean {
  return transcriptDistanceFromEnd(transcript) <= threshold;
}

export function preferredScrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

export function scrollTranscriptToEnd(transcript: HTMLDivElement | null, behavior: ScrollBehavior = "smooth"): void {
  if (!transcript) return;

  if (behavior === "auto") {
    const previousScrollBehavior = transcript.style.scrollBehavior;
    transcript.style.scrollBehavior = "auto";
    transcript.scrollTo({ top: transcript.scrollHeight, behavior });
    transcript.style.scrollBehavior = previousScrollBehavior;
    return;
  }

  transcript.scrollTo({ top: transcript.scrollHeight, behavior });
}

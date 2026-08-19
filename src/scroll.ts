export function scrollTranscriptToEnd(transcript: HTMLDivElement | null, behavior: ScrollBehavior = "smooth"): void {
  if (!transcript) return;
  transcript.scrollTo({ top: transcript.scrollHeight, behavior });
}

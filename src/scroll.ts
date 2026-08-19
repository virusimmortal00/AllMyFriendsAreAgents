export function scrollTranscriptToEnd(transcript: HTMLDivElement | null): void {
  if (!transcript) return;
  transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
}

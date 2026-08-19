export function scrollTranscriptToEnd(element: HTMLDivElement | null): void {
  element?.scrollIntoView({ behavior: "smooth" });
}


export function reconnectDelayMs(attempt: number, random = Math.random) {
  const base = Math.min(15_000, 750 * (2 ** Math.max(0, attempt)));
  return Math.round(base * (0.8 + random() * 0.4));
}

type ScrollElement = Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTop">;

export function scrollDistanceFromBottom(element: ScrollElement | null) {
  if (!element) return 0;
  return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
}

export function restoreScrollDistance(element: ScrollElement | null, distance: number) {
  if (!element) return;
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - distance);
}

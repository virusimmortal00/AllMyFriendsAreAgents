export type WorkshopDialogEvent = { type: "open"; id: string } | { type: "close" } | { type: "escape" };

/** Small interaction model shared by the workshop trigger and dialog. */
export function nextWorkshopId(_current: string | null, event: WorkshopDialogEvent): string | null {
  return event.type === "open" ? event.id : null;
}

/** Returns the next focusable index when Tab is pressed inside a modal. */
export function nextDialogFocusIndex(current: number, total: number, backwards = false) {
  if (total < 1) return -1;
  return (current + (backwards ? -1 : 1) + total) % total;
}

export function workshopLayout(viewportWidth: number): "desktop-dialog" | "mobile-sheet" {
  return viewportWidth <= 720 ? "mobile-sheet" : "desktop-dialog";
}

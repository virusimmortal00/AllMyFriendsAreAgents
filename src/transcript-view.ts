export const TRANSCRIPT_MAGNIFICATION_LEVELS = [75, 90, 100, 110, 125, 150] as const;
export const DEFAULT_TRANSCRIPT_MAGNIFICATION = 100;
export const TRANSCRIPT_MAGNIFICATION_STORAGE_KEY = "allmyfriendsareagents.transcript-magnification";
export const TRANSCRIPT_TIMESTAMPS_STORAGE_KEY = "allmyfriendsareagents.transcript-timestamps";

export function sanitizeTranscriptMagnification(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return TRANSCRIPT_MAGNIFICATION_LEVELS.includes(numeric as typeof TRANSCRIPT_MAGNIFICATION_LEVELS[number])
    ? numeric
    : DEFAULT_TRANSCRIPT_MAGNIFICATION;
}

export function adjacentTranscriptMagnification(current: number, direction: -1 | 1) {
  const normalized = sanitizeTranscriptMagnification(current);
  const index = TRANSCRIPT_MAGNIFICATION_LEVELS.indexOf(normalized as typeof TRANSCRIPT_MAGNIFICATION_LEVELS[number]);
  const nextIndex = Math.min(TRANSCRIPT_MAGNIFICATION_LEVELS.length - 1, Math.max(0, index + direction));
  return TRANSCRIPT_MAGNIFICATION_LEVELS[nextIndex];
}

export function loadTranscriptMagnification() {
  if (typeof window === "undefined") return DEFAULT_TRANSCRIPT_MAGNIFICATION;
  try {
    return sanitizeTranscriptMagnification(window.localStorage.getItem(TRANSCRIPT_MAGNIFICATION_STORAGE_KEY));
  } catch {
    return DEFAULT_TRANSCRIPT_MAGNIFICATION;
  }
}

export function saveTranscriptMagnification(value: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TRANSCRIPT_MAGNIFICATION_STORAGE_KEY, String(sanitizeTranscriptMagnification(value)));
  } catch {
    // A blocked localStorage should not make the room unusable.
  }
}

export function loadTranscriptTimestamps() {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(TRANSCRIPT_TIMESTAMPS_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveTranscriptTimestamps(visible: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TRANSCRIPT_TIMESTAMPS_STORAGE_KEY, String(visible));
  } catch {
    // A blocked localStorage should not make the room unusable.
  }
}

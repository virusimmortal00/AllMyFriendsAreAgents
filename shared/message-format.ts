const DISPOSITION_LINE = /^\s*DISPOSITION:\s*(?:AGREE|CONCERN|PROPOSAL|NEEDS_USER)\s*$/gim;

export const NO_RESPONSE_NEEDED = "NO_RESPONSE_NEEDED";

export function visibleAgentText(text: string): string {
  return text.replace(DISPOSITION_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function isNoResponseNeeded(text: string): boolean {
  return visibleAgentText(text) === NO_RESPONSE_NEEDED;
}

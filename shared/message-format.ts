const DISPOSITION_LINE = /^\s*DISPOSITION:\s*(?:AGREE|CONCERN|PROPOSAL|NEEDS_USER)\s*$/gim;
const CONVERSATION_STATE_LINE = /^\s*CONVERSATION_STATE:\s*(?:SETTLED|OPEN|BLOCKED)\s*$/gim;
const STYLE_LINE = /^\s*STYLE:\s*\{[^\n]*\}\s*$/gim;
const INVESTIGATION_LINE = /^\s*INVESTIGATION_REQUEST:\s*\{[^\n]*\}\s*$/gim;
const TURN_DISPOSITION_LINE = /^\s*TURN_DISPOSITION:\s*.*$/gim;
const INTERNAL_PREFACE = /\b(?:plan mode|planning workflow|not a coding task|system prompt|developer instructions?|internal (?:dialogue|reasoning|instructions?)|respond normally|skip (?:the )?(?:plan|planning)(?:ning)? workflow)\b/i;

export const NO_RESPONSE_NEEDED = "NO_RESPONSE_NEEDED";

export const YIELD_REASONS = [
  "not_addressed",
  "another_agent_owns_this",
  "already_covered",
  "no_distinct_contribution",
  "conversation_settled",
] as const;

export type YieldReason = (typeof YIELD_REASONS)[number];

export type ParsedTurnDisposition =
  | { status: "missing" }
  | { status: "malformed" }
  | { status: "valid"; action: "speak" }
  | { status: "valid"; action: "yield"; reason: YieldReason };

export function parseTurnDisposition(text: string): ParsedTurnDisposition {
  const lines = text.split(/\r?\n/).filter((line) => /^\s*TURN_DISPOSITION\s*:/i.test(line));
  if (lines.length === 0) return { status: "missing" };
  if (lines.length !== 1) return { status: "malformed" };
  const raw = lines[0].replace(/^\s*TURN_DISPOSITION\s*:\s*/i, "").trim();
  try {
    const value = JSON.parse(raw) as { action?: unknown; reason?: unknown };
    if (!value || typeof value !== "object") return { status: "malformed" };
    if (value.action === "speak" && value.reason === undefined) return { status: "valid", action: "speak" };
    if (value.action === "yield" && YIELD_REASONS.includes(value.reason as YieldReason)) {
      return { status: "valid", action: "yield", reason: value.reason as YieldReason };
    }
    return { status: "malformed" };
  } catch {
    return { status: "malformed" };
  }
}

export function visibleAgentText(text: string): string {
  return text
    .replace(DISPOSITION_LINE, "")
    .replace(CONVERSATION_STATE_LINE, "")
    .replace(STYLE_LINE, "")
    .replace(INVESTIGATION_LINE, "")
    .replace(TURN_DISPOSITION_LINE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function visibleAgentChatText(text: string): string {
  const visible = visibleAgentText(text);
  const paragraphs = visible.split(/\n\s*\n/);
  while (paragraphs.length > 1 && INTERNAL_PREFACE.test(paragraphs[0])) paragraphs.shift();
  return paragraphs.join("\n\n").trim();
}

export function isNoResponseNeeded(text: string): boolean {
  const visible = visibleAgentChatText(text);
  return visible === NO_RESPONSE_NEEDED || /(?:^|\s)NO_RESPONSE_NEEDED\s*$/.test(visible);
}

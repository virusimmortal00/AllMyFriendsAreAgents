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
  return visibleAgentTextWithDiagnostics(text).text;
}

function visibleAgentTextWithDiagnostics(text: string) {
  let protocolDirectives = 0;
  let protocolCharacters = 0;
  for (const pattern of [DISPOSITION_LINE, CONVERSATION_STATE_LINE, STYLE_LINE, INVESTIGATION_LINE, TURN_DISPOSITION_LINE]) {
    text = text.replace(pattern, (match) => {
      protocolDirectives++;
      protocolCharacters += match.length;
      return "";
    });
  }
  const visible = text.replace(/\n{3,}/g, "\n\n").trim();
  return { text: visible, protocolDirectives, protocolCharacters, whitespaceCharacters: text.length - visible.length };
}

export function stripAgentSelfLabel(text: string, speakerName?: string): string {
  if (!speakerName) return text;
  const prefix = /^\s*\[([^\]\r\n]+)\](?:[ \t]+|\r?\n|$)/.exec(text);
  return prefix?.[1].toLowerCase() === speakerName.toLowerCase() ? text.slice(prefix[0].length).trimStart() : text;
}

export function visibleAgentChatText(text: string, speakerName?: string): string {
  return visibleAgentChatTextWithDiagnostics(text, speakerName).text;
}

export function visibleAgentChatTextWithDiagnostics(text: string, speakerName?: string) {
  const visible = visibleAgentTextWithDiagnostics(text);
  const paragraphs = visible.text.split(/\n\s*\n/);
  const normalizedLength = paragraphs.join("\n\n").length;
  let workflowPrefaceParagraphs = 0;
  while (paragraphs.length > 1 && INTERNAL_PREFACE.test(paragraphs[0])) {
    paragraphs.shift();
    workflowPrefaceParagraphs++;
  }
  const remaining = paragraphs.join("\n\n");
  const trimmed = remaining.trim();
  const withoutLabel = stripAgentSelfLabel(trimmed, speakerName);
  return {
    ...visible, text: withoutLabel, workflowPrefaceParagraphs,
    workflowPrefaceCharacters: normalizedLength - remaining.length,
    speakerLabelCharacters: trimmed.length - withoutLabel.length,
    whitespaceCharacters: visible.whitespaceCharacters + visible.text.length - normalizedLength + remaining.length - trimmed.length,
  };
}

export function isNoResponseNeeded(text: string): boolean {
  const visible = visibleAgentChatText(text);
  return visible === NO_RESPONSE_NEEDED || /(?:^|\s)NO_RESPONSE_NEEDED\s*$/.test(visible);
}

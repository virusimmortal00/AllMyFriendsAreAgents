const DISPOSITION_LINE = /^\s*DISPOSITION:\s*(?:AGREE|CONCERN|PROPOSAL|NEEDS_USER)\s*$/gim;
const CONVERSATION_STATE_LINE = /^\s*CONVERSATION_STATE:\s*(?:SETTLED|OPEN|BLOCKED)\s*$/gim;
const STYLE_LINE = /^\s*STYLE:\s*\{[^\n]*\}\s*$/gim;
const INTERNAL_PREFACE = /\b(?:plan mode|planning workflow|not a coding task|system prompt|developer instructions?|internal (?:dialogue|reasoning|instructions?)|respond normally|skip (?:the )?(?:plan|planning)(?:ning)? workflow)\b/i;

export const NO_RESPONSE_NEEDED = "NO_RESPONSE_NEEDED";

export function visibleAgentText(text: string): string {
  return text
    .replace(DISPOSITION_LINE, "")
    .replace(CONVERSATION_STATE_LINE, "")
    .replace(STYLE_LINE, "")
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
  return visibleAgentChatText(text) === NO_RESPONSE_NEEDED;
}

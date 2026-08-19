export const CHAT_FONT_FAMILIES = [
  "Arial",
  "Times New Roman",
  "Georgia",
  "Comic Sans MS",
  "Courier New",
  "Trebuchet MS",
] as const;

export type ChatFontFamily = (typeof CHAT_FONT_FAMILIES)[number];

export interface ChatStyle {
  fontFamily: ChatFontFamily;
  fontSize: number;
  textColor: string;
  backgroundColor: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export type StyledParticipant = "you" | "codex" | "claude";
export type ParticipantStyles = Record<StyledParticipant, ChatStyle>;

export const DEFAULT_PARTICIPANT_STYLES: ParticipantStyles = {
  you: {
    fontFamily: "Arial",
    fontSize: 17,
    textColor: "#101cda",
    backgroundColor: "#f3f5ff",
    bold: false,
    italic: false,
    underline: false,
  },
  codex: {
    fontFamily: "Trebuchet MS",
    fontSize: 17,
    textColor: "#075f15",
    backgroundColor: "#f2fff4",
    bold: false,
    italic: false,
    underline: false,
  },
  claude: {
    fontFamily: "Georgia",
    fontSize: 17,
    textColor: "#8a3500",
    backgroundColor: "#fff7ef",
    bold: false,
    italic: false,
    underline: false,
  },
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function sanitizeChatStyle(input: unknown, fallback: ChatStyle): ChatStyle {
  const value = input && typeof input === "object" ? input as Partial<ChatStyle> : {};
  return {
    fontFamily: CHAT_FONT_FAMILIES.includes(value.fontFamily as ChatFontFamily) ? value.fontFamily as ChatFontFamily : fallback.fontFamily,
    fontSize: typeof value.fontSize === "number" && Number.isFinite(value.fontSize)
      ? Math.min(28, Math.max(12, Math.round(value.fontSize)))
      : fallback.fontSize,
    textColor: typeof value.textColor === "string" && HEX_COLOR.test(value.textColor) ? value.textColor.toLowerCase() : fallback.textColor,
    backgroundColor: typeof value.backgroundColor === "string" && HEX_COLOR.test(value.backgroundColor) ? value.backgroundColor.toLowerCase() : fallback.backgroundColor,
    bold: typeof value.bold === "boolean" ? value.bold : fallback.bold,
    italic: typeof value.italic === "boolean" ? value.italic : fallback.italic,
    underline: typeof value.underline === "boolean" ? value.underline : fallback.underline,
  };
}

export function normalizeParticipantStyles(input: unknown): ParticipantStyles {
  const value = input && typeof input === "object" ? input as Partial<ParticipantStyles> : {};
  return {
    you: sanitizeChatStyle(value.you, DEFAULT_PARTICIPANT_STYLES.you),
    codex: sanitizeChatStyle(value.codex, DEFAULT_PARTICIPANT_STYLES.codex),
    claude: sanitizeChatStyle(value.claude, DEFAULT_PARTICIPANT_STYLES.claude),
  };
}

export function extractStyleDirective(text: string, fallback: ChatStyle): ChatStyle | undefined {
  const match = text.match(/^\s*STYLE:\s*(\{[^\n]*\})\s*$/im);
  if (!match) return undefined;
  try {
    return sanitizeChatStyle(JSON.parse(match[1]), fallback);
  } catch {
    return undefined;
  }
}

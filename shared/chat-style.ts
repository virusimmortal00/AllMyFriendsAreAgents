import { AGENT_IDS, type ParticipantId } from "./participants.js";

export const CHAT_FONT_FAMILIES = [
  "Arial",
  "Times New Roman",
  "Georgia",
  "Comic Sans MS",
  "Courier New",
  "Trebuchet MS",
  "Tahoma",
  "Verdana",
] as const;

export type ChatFontFamily = (typeof CHAT_FONT_FAMILIES)[number];

export const CHAT_FONT_STACKS: Record<ChatFontFamily, string> = {
  Arial: 'Arial, Helvetica, sans-serif',
  "Times New Roman": '"Times New Roman", Times, serif',
  Georgia: 'Georgia, "Times New Roman", serif',
  "Comic Sans MS": '"Comic Sans MS", "Comic Sans", "Chalkboard SE", cursive',
  "Courier New": '"Courier New", Courier, monospace',
  "Trebuchet MS": '"Trebuchet MS", Arial, sans-serif',
  Tahoma: 'Tahoma, Geneva, sans-serif',
  Verdana: 'Verdana, Geneva, sans-serif',
};

export const CHAT_FONT_SIZES = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28] as const;

// AIM 5.x used the Windows-era 8x6 basic color grid and an 8x2 grayscale
// custom-color row. Keep these values finite so the UI and agent directives
// share the same period-appropriate palette.
export const AIM_5_BASIC_COLORS = [
  "#f07d77", "#fefe78", "#8ffa76", "#5df975", "#91fbfe", "#3074fd", "#f07db9", "#f17eff",
  "#ec301a", "#fefe1e", "#8ffa13", "#5cf93a", "#5ffafe", "#2d73b7", "#7575b7", "#ed36ff",
  "#6e3b39", "#f07c3e", "#5cf90f", "#2b7274", "#173874", "#7677fe", "#6c1739", "#ec3177",
  "#6c160a", "#f07c1b", "#2a7204", "#2a7238", "#1618fd", "#0c0d94", "#6c1974", "#6e20fd",
  "#340a00", "#6e3b0a", "#0c3800", "#0c3838", "#0c0d74", "#000038", "#340a38", "#360e74",
  "#000000", "#74740d", "#747439", "#757575", "#447374", "#b8b8b8", "#340a38", "#ffffff",
] as const;

export const AIM_5_CUSTOM_COLORS = [
  "#111111", "#1d1d1d", "#292929", "#373737", "#464646", "#545454", "#646464", "#747474",
  "#848484", "#959595", "#a5a5a5", "#b7b7b7", "#c8c8c8", "#dadada", "#ececec", "#ffffff",
] as const;

export const AIM_5_COLOR_PALETTE = [...new Set([...AIM_5_BASIC_COLORS, ...AIM_5_CUSTOM_COLORS])] as readonly string[];

export interface ChatStyle {
  fontFamily: ChatFontFamily;
  fontSize: number;
  textColor: string;
  backgroundColor: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export type StyledParticipant = ParticipantId;
export type ParticipantStyles = Record<StyledParticipant, ChatStyle>;

export const DEFAULT_PARTICIPANT_STYLES: ParticipantStyles = {
  you: {
    fontFamily: "Arial",
    fontSize: 17,
    textColor: "#1618fd",
    backgroundColor: "#ffffff",
    bold: false,
    italic: false,
    underline: false,
  },
  "codex-luna": {
    fontFamily: "Trebuchet MS",
    fontSize: 17,
    textColor: "#2a7238",
    backgroundColor: "#ffffff",
    bold: false,
    italic: false,
    underline: false,
  },
  "codex-terra": {
    fontFamily: "Tahoma",
    fontSize: 17,
    textColor: "#6c1974",
    backgroundColor: "#ffffff",
    bold: false,
    italic: false,
    underline: false,
  },
  "codex-sol": {
    fontFamily: "Courier New",
    fontSize: 18,
    textColor: "#2d73b7",
    backgroundColor: "#ffffff",
    bold: false,
    italic: false,
    underline: false,
  },
  "claude-sonnet": {
    fontFamily: "Georgia",
    fontSize: 17,
    textColor: "#f07c1b",
    backgroundColor: "#ffffff",
    bold: false,
    italic: false,
    underline: false,
  },
  "cursor-grok": {
    fontFamily: "Comic Sans MS",
    fontSize: 17,
    textColor: "#ec301a",
    backgroundColor: "#ffffff",
    bold: false,
    italic: false,
    underline: false,
  },
  "cursor-gemini": {
    fontFamily: "Verdana",
    fontSize: 16,
    textColor: "#2b7274",
    backgroundColor: "#ffffff",
    bold: false,
    italic: false,
    underline: false,
  },
  "cursor-composer": {
    fontFamily: "Times New Roman",
    fontSize: 18,
    textColor: "#6e3b0a",
    backgroundColor: "#ffffff",
    bold: false,
    italic: false,
    underline: false,
  },
};

function sanitizePaletteColor(value: unknown, fallback: string, safeDefault: string) {
  const normalizedValue = typeof value === "string" ? value.toLowerCase() : "";
  if (AIM_5_COLOR_PALETTE.includes(normalizedValue)) return normalizedValue;
  const normalizedFallback = fallback.toLowerCase();
  return AIM_5_COLOR_PALETTE.includes(normalizedFallback) ? normalizedFallback : safeDefault;
}

export function sanitizeChatStyle(input: unknown, fallback: ChatStyle): ChatStyle {
  const value = input && typeof input === "object" ? input as Partial<ChatStyle> : {};
  return {
    fontFamily: CHAT_FONT_FAMILIES.includes(value.fontFamily as ChatFontFamily) ? value.fontFamily as ChatFontFamily : fallback.fontFamily,
    fontSize: typeof value.fontSize === "number" && Number.isFinite(value.fontSize)
      ? Math.min(28, Math.max(12, Math.round(value.fontSize)))
      : fallback.fontSize,
    textColor: sanitizePaletteColor(value.textColor, fallback.textColor, "#000000"),
    backgroundColor: sanitizePaletteColor(value.backgroundColor, fallback.backgroundColor, "#ffffff"),
    bold: typeof value.bold === "boolean" ? value.bold : fallback.bold,
    italic: typeof value.italic === "boolean" ? value.italic : fallback.italic,
    underline: typeof value.underline === "boolean" ? value.underline : fallback.underline,
  };
}

export function normalizeParticipantStyles(input: unknown): ParticipantStyles {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const normalized = {
    you: sanitizeChatStyle(value.you, DEFAULT_PARTICIPANT_STYLES.you),
  } as ParticipantStyles;
  for (const agent of AGENT_IDS) {
    const legacy = agent === "codex-sol" ? value.codex : agent === "claude-sonnet" ? value.claude : undefined;
    normalized[agent] = sanitizeChatStyle(value[agent] ?? legacy, DEFAULT_PARTICIPANT_STYLES[agent]);
  }
  return normalized;
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

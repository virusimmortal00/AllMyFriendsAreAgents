export const AIM_SMILEY_SHORTCUTS = [
  ":-)",
  ":-!",
  ":-[",
  "O:-)",
  ":-\\",
  ":'(",
  ":-X",
  ":-D",
  ":-(",
  ";-)",
  ":-P",
  "=-O",
  ":-*",
  ">:O",
  "8-)",
  ":-$",
] as const;

const UNSUPPORTED_EMOJI_GRAPHEME = /\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\uFE0F|\u20E3/u;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export function stripUnsupportedEmoji(text: string): string {
  return [...graphemes.segment(text)]
    .map(({ segment }) => UNSUPPORTED_EMOJI_GRAPHEME.test(segment) ? "" : segment)
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

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
  return stripUnsupportedEmojiWithDiagnostics(text).text;
}

export function stripUnsupportedEmojiWithDiagnostics(text: string) {
  let removedCharacters = 0;
  let removedGraphemes = 0;
  const withoutEmoji = [...graphemes.segment(text)]
    .map(({ segment }) => {
      if (!UNSUPPORTED_EMOJI_GRAPHEME.test(segment)) return segment;
      removedCharacters += segment.length;
      removedGraphemes++;
      return "";
    }).join("");
  const visible = withoutEmoji
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return { text: visible, removedCharacters, removedGraphemes, whitespaceCharacters: withoutEmoji.length - visible.length };
}

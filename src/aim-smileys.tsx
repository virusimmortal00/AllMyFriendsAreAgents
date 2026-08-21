import type { ReactNode } from "react";

export interface AimSmiley {
  name: string;
  shortcut: string;
  aliases: readonly string[];
  src: string;
}

const smileyAsset = (name: string) => `/smileys/${name}.png`;

export const AIM_SMILEYS: readonly AimSmiley[] = [
  { name: "Smile", shortcut: ":-)", aliases: [":-)", ":)"], src: smileyAsset("smile") },
  { name: "Foot in mouth", shortcut: ":-!", aliases: [":-!"], src: smileyAsset("foot-in-mouth") },
  { name: "Embarrassed", shortcut: ":-[", aliases: [":-["], src: smileyAsset("embarrassed") },
  { name: "Angel", shortcut: "O:-)", aliases: ["O:-)"], src: smileyAsset("angel") },
  { name: "Undecided", shortcut: ":-\\", aliases: [":-\\"], src: smileyAsset("undecided") },
  { name: "Crying", shortcut: ":'(", aliases: [":'("], src: smileyAsset("crying") },
  { name: "Lips sealed", shortcut: ":-X", aliases: [":-X", ":-x"], src: smileyAsset("lips-sealed") },
  { name: "Big grin", shortcut: ":-D", aliases: [":-D", ":D"], src: smileyAsset("big-grin") },
  { name: "Frown", shortcut: ":-(", aliases: [":-(", ":("], src: smileyAsset("frown") },
  { name: "Wink", shortcut: ";-)", aliases: [";-)", ";)"], src: smileyAsset("wink") },
  { name: "Tongue", shortcut: ":-P", aliases: [":-P", ":-p"], src: smileyAsset("tongue") },
  { name: "Surprised", shortcut: "=-O", aliases: ["=-O", "=-o"], src: smileyAsset("surprised") },
  { name: "Kiss", shortcut: ":-*", aliases: [":-*"], src: smileyAsset("kiss") },
  { name: "Yelling", shortcut: ">:O", aliases: [">:O", ">:o"], src: smileyAsset("yelling") },
  { name: "Cool", shortcut: "8-)", aliases: ["8-)"], src: smileyAsset("cool") },
  { name: "Money mouth", shortcut: ":-$", aliases: [":-$"], src: smileyAsset("money-mouth") },
];

const smileyByAlias = new Map(AIM_SMILEYS.flatMap((smiley) => smiley.aliases.map((alias) => [alias, smiley] as const)));
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const smileyPattern = new RegExp(`(${[...smileyByAlias.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`, "g");

export function renderAimSmileys(text: string): ReactNode[] {
  return text.split(smileyPattern).filter(Boolean).map((part, index) => {
    const smiley = smileyByAlias.get(part);
    return smiley ? (
      <img className="aim-smiley" src={smiley.src} alt={`${smiley.name} ${part}`} title={`${smiley.name} (${part})`} key={`${index}-${part}`} />
    ) : part;
  });
}

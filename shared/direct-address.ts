import type { AgentId } from "./participants.js";

export interface AddressableAgent {
  agentId: AgentId;
  name: string;
}

export interface DirectAddressInput {
  text: string;
  agents: readonly AddressableAgent[];
  humanNames?: readonly string[];
  speaker: "human" | "agent";
}

const REQUEST_START =
  /^(?:your\s+turn\b|can|could|would|will|do|did|are|is|have|has|should|may|might|what|why|how|where|when|please|take|look|check|review|share|give|tell|help|weigh|respond|answer|reply|summarize|explain|describe|show|try|handle|investigate|read|write|build|fix|analy[sz]e|compare|argue|decide|choose|draft|run|test|update)\b/i;
const LEADING_GIVEN_CONTEXT = /^given\b[^.!?;\n]{1,160},\s*/i;
const UNPUNCTUATED_REQUEST =
  /^(?:(?:can|could|would|will|should)\s+you\b|(?:what|why|how|where|when)\s+(?:do|would|should|can|could|are|is)\s+you\b|please\s+)/i;
const SHORT_PROMPT = /^(?:thoughts|your (?:thoughts|take|view|opinion))\s*\?/i;
const HUMAN_SHORT_PROMPT = /^any ideas\s*\?/i;
const REQUEST_END =
  /\b(?:can|could|would|will|do|did|are|is|have|has|should|may|might)\s+you\b|\b(?:what|why|how|where|when)\s+(?:do|would|should|can|could|are|is)\s+you\b|\b(?:your (?:thoughts|take|view|opinion)|thoughts)\b|\bplease\b/i;
const LEADING_GREETING = /^(?:(?:hey|hi|hello)\s+)/i;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function visibleAddressProse(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|'[^'\n]*'/g, " ");
}

/**
 * Recognizes only unambiguous vocatives attached to a request. This is a
 * conservative routing signal, not a general named-entity or intent parser.
 */
function directNames(input: DirectAddressInput, targetNames: readonly string[], otherNames: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of [...targetNames, ...otherNames]) {
    const key = name.trim().toLocaleLowerCase();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unique = targetNames.filter((name) => counts.get(name.trim().toLocaleLowerCase()) === 1 && name.trim().length >= 2);
  if (!unique.length) return [];
  const names = unique.map((name) => escapeRegExp(name)).sort((left, right) => right.length - left.length);
  const namePattern = `(?:${names.join("|")})`;
  const listPattern = `(${namePattern}(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+)${namePattern})*)`;
  const leading = new RegExp(`^${listPattern}(\\s*[:,—-]\\s*|\\s+)(.+)$`, "i");
  const trailing = new RegExp(`^(.+?)[,;]\\s*${listPattern}\\s*[?!]?$`, "i");
  const nameMatcher = new RegExp(namePattern, "gi");
  const found = new Set<string>();
  for (const rawLine of visibleAddressProse(input.text).replace(/@(?=[\p{L}\p{N}])/gu, "").split(/\n|(?<=[.!?])\s+/)) {
    const line = rawLine.trim().replace(LEADING_GREETING, "");
    const front = leading.exec(line);
    if (front) {
      const body = front[3]?.trim() ?? "";
      const punctuated = /[:,—-]/.test(front[2] ?? "");
      if (
        (punctuated &&
          (REQUEST_START.test(body) ||
            (LEADING_GIVEN_CONTEXT.test(body) && REQUEST_START.test(body.replace(LEADING_GIVEN_CONTEXT, ""))) ||
            SHORT_PROMPT.test(body) ||
            (input.speaker === "human" && HUMAN_SHORT_PROMPT.test(body)))) ||
        (!punctuated && UNPUNCTUATED_REQUEST.test(body))
      ) {
        for (const match of front[1]?.matchAll(nameMatcher) ?? []) {
          found.add(match[0].toLocaleLowerCase());
        }
      }
    }
    const back = trailing.exec(line);
    if (back && REQUEST_END.test(back[1] ?? "")) {
      for (const match of back[2]?.matchAll(nameMatcher) ?? []) {
        found.add(match[0].toLocaleLowerCase());
      }
    }
  }
  return [...found];
}

export function directAddressTargets(input: DirectAddressInput): AgentId[] {
  const byName = new Map(input.agents.map(({ name, agentId }) => [name.trim().toLocaleLowerCase(), agentId]));
  return directNames(input, input.agents.map(({ name }) => name), input.humanNames ?? [])
    .flatMap((name) => { const target = byName.get(name); return target ? [target] : []; });
}

/** A named human vocative leaves the next turn with that human. */
export function directHumanAddressNames(input: DirectAddressInput): string[] {
  const byName = new Map((input.humanNames ?? []).map((name) => [name.trim().toLocaleLowerCase(), name]));
  return directNames(input, input.humanNames ?? [], input.agents.map(({ name }) => name))
    .flatMap((name) => { const target = byName.get(name); return target ? [target] : []; });
}

import { AGENT_IDS, AGENT_PROFILES, agentScreenName, type ActiveAgentId } from "./participants.js";

export interface MessageMention {
  readonly targetKind: "agent" | "human";
  readonly targetId: string;
  readonly label: string;
  readonly providerSnapshot?: string;
  readonly modelSnapshot?: string;
  readonly revision: number;
  readonly start: number;
  readonly end: number;
}

export interface MentionCandidate {
  readonly targetKind: MessageMention["targetKind"];
  readonly targetId: string;
  readonly label: string;
  readonly description: string;
  readonly providerSnapshot?: string;
  readonly modelSnapshot?: string;
  readonly revision: number;
}

export function roomMentionCandidates(humans: readonly { id: string; name: string }[]): MentionCandidate[] {
  const agents = AGENT_IDS.map((id: ActiveAgentId) => {
    const profile = AGENT_PROFILES[id];
    return {
      targetKind: "agent" as const,
      targetId: id,
      label: profile.conversationalName,
      description: agentScreenName(id),
      providerSnapshot: profile.provider,
      modelSnapshot: profile.modelLabel,
      revision: 1,
    };
  });
  const humanNameCounts = new Map<string, number>();
  for (const { name } of humans) humanNameCounts.set(name, (humanNameCounts.get(name) ?? 0) + 1);
  const people = humans.map(({ id, name }) => ({
    targetKind: "human" as const,
    targetId: id,
    label: name,
    description: humanNameCounts.get(name) === 1 ? "Human participant" : `Human participant · ${id}`,
    revision: 1,
  }));
  return [...agents, ...people];
}

export function reconcileMessageMentionsAfterEdit(
  previousText: string,
  nextText: string,
  mentions: readonly MessageMention[],
) {
  let prefixLength = 0;
  while (prefixLength < previousText.length && prefixLength < nextText.length
    && previousText[prefixLength] === nextText[prefixLength]) prefixLength += 1;

  let suffixLength = 0;
  while (suffixLength < previousText.length - prefixLength && suffixLength < nextText.length - prefixLength
    && previousText[previousText.length - suffixLength - 1] === nextText[nextText.length - suffixLength - 1]) suffixLength += 1;

  const previousEditEnd = previousText.length - suffixLength;
  const nextEditEnd = nextText.length - suffixLength;
  const delta = nextEditEnd - previousEditEnd;
  const remapped = mentions.flatMap((mention) => {
    if (mention.end <= prefixLength) return [mention];
    if (mention.start >= previousEditEnd) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    return [];
  });
  return reconcileMessageMentions(nextText, remapped);
}

export function reconcileMessageMentions(text: string, mentions: readonly MessageMention[]) {
  const groups = new Map<string, MessageMention[]>();
  for (const mention of mentions) groups.set(mention.label, [...(groups.get(mention.label) || []), mention]);
  return [...groups.entries()].flatMap(([label, labelMentions]) => {
    const token = `@${label}`;
    const occurrences: number[] = [];
    for (let start = text.indexOf(token); start >= 0; start = text.indexOf(token, start + 1)) occurrences.push(start);
    if (labelMentions.length === 1) {
      if (occurrences.length === 1) return [{ ...labelMentions[0], start: occurrences[0], end: occurrences[0] + token.length }];
      const exact = occurrences.filter((start) => start === labelMentions[0].start);
      return exact.length === 1 ? [{ ...labelMentions[0], start: exact[0], end: exact[0] + token.length }] : [];
    }
    if (occurrences.length !== labelMentions.length) return [];
    return [...labelMentions]
      .sort((left, right) => left.start - right.start)
      .map((mention, index) => ({ ...mention, start: occurrences[index], end: occurrences[index] + token.length }));
  }).sort((left, right) => left.start - right.start);
}

export function validateMessageMentions(
  input: unknown,
  text: string,
  candidates: readonly MentionCandidate[],
): MessageMention[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 20) throw new Error("Message mentions are invalid.");
  const allowed = new Map(candidates.map((candidate) => [`${candidate.targetKind}:${candidate.targetId}`, candidate]));
  const mentions = input.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Message mentions are invalid.");
    const mention = value as Partial<MessageMention>;
    const candidate = allowed.get(`${mention.targetKind}:${mention.targetId}`);
    if (!candidate || mention.label !== candidate.label || mention.revision !== candidate.revision
      || !Number.isInteger(mention.start) || !Number.isInteger(mention.end)
      || mention.start! < 0 || mention.end! <= mention.start! || mention.end! > text.length) {
      throw new Error("Message mentions are invalid.");
    }
    const normalized: MessageMention = {
      targetKind: candidate.targetKind,
      targetId: candidate.targetId,
      label: candidate.label,
      providerSnapshot: candidate.providerSnapshot,
      modelSnapshot: candidate.modelSnapshot,
      revision: candidate.revision,
      start: mention.start!,
      end: mention.end!,
    };
    if (text.slice(normalized.start, normalized.end) !== `@${normalized.label}`) {
      throw new Error("Message mention text no longer matches its target.");
    }
    return normalized;
  });
  const sorted = mentions.sort((left, right) => left.start - right.start);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start < sorted[index - 1].end) throw new Error("Message mentions cannot overlap.");
  }
  return sorted;
}

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
  const people = humans.map(({ id, name }) => ({
    targetKind: "human" as const,
    targetId: id,
    label: name,
    description: name,
    revision: 1,
  }));
  // Ranking boost for structured agent mentions (agents first)
  return [...agents, ...people];
}

export function reconcileMessageMentions(text: string, mentions: readonly MessageMention[]) {
  const claimed = new Set<number>();
  return mentions.flatMap((mention) => {
    const token = `@${mention.label}`;
    let start = text.indexOf(token);
    while (start >= 0 && claimed.has(start)) start = text.indexOf(token, start + 1);
    if (start < 0) return [];
    claimed.add(start);
    return [{ ...mention, start, end: start + token.length }];
  });
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
      || !Number.isInteger(mention.start) || !Number.isInteger(mention.end)) {
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
  return mentions.sort((left, right) => left.start - right.start);
}

import { createHash } from "node:crypto";

export const JEV_QUESTION_PROFILE_IDS = ["current-v1", "lean-v1", "relevance-v1"] as const;
export type JevQuestionProfileId = (typeof JEV_QUESTION_PROFILE_IDS)[number];
export const JEV_GATE_PROFILE_IDS = ["current-v1", "relevance-v1"] as const;
export type JevGateProfileId = (typeof JEV_GATE_PROFILE_IDS)[number];

const QUESTION_PROFILES = {
  "current-v1": { stateShape: "visible-transcript-v1", primaryChoice: true, optionalWorthQuestion: false },
  "lean-v1": { stateShape: "visible-transcript-v1", primaryChoice: false, optionalWorthQuestion: false },
  "relevance-v1": { stateShape: "visible-transcript-v1", primaryChoice: false, optionalWorthQuestion: true },
} as const;

export const JEV_QUESTION_TEXT = {
  wholeRoom: "The most recent message in this conversation invites every participant to respond.",
  primary: "Who is the most recent message primarily addressed to?",
  primaryAgent: "The agent participant {name}",
  primaryHuman: "The human who sent the most recent message is themselves the addressee",
  primaryNone: "No single participant is primarily addressed",
  direct: "The most recent message directly addresses {name}: it asks {name} to answer, act, or reply. A recap, attribution, correction of someone else, or aside that merely mentions {name} without requesting a response from them does not count.",
  optionalWorth: "Given this conversation and the most recent message, would a voluntary next reply from {name} add a distinct useful idea or a fitting brief social reaction? Count no if it would only repeat, recap, interrupt a clear human handoff, or add nothing useful. This is separate from whether {name} was directly addressed.",
} as const;

export function jevQuestionForName(template: string, name: string) {
  return template.replaceAll("{name}", name);
}

const GATE_PROFILES = {
  "current-v1": { optionalWorthThreshold: null },
  // A candidate only: low predicted optional value can remove an optional seat,
  // never an explicit obligation. Missing predictions preserve eligibility.
  "relevance-v1": { optionalWorthThreshold: 0.35 },
} as const;

export function jevQuestionProfile(id: JevQuestionProfileId) {
  return QUESTION_PROFILES[id];
}

export function jevGateProfile(id: JevGateProfileId) {
  return GATE_PROFILES[id];
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Closed scalar provenance for isolated evaluation; no prompt or transcript data. */
export function jevProfileMetadata(questionId: JevQuestionProfileId, gateId: JevGateProfileId) {
  const question = QUESTION_PROFILES[questionId];
  return {
    jevProfileId: questionId,
    jevProfileDigest: digest({
      id: questionId, ...question,
      wholeRoom: JEV_QUESTION_TEXT.wholeRoom,
      direct: JEV_QUESTION_TEXT.direct,
      ...(question.primaryChoice ? { primary: JEV_QUESTION_TEXT.primary, primaryAgent: JEV_QUESTION_TEXT.primaryAgent, primaryHuman: JEV_QUESTION_TEXT.primaryHuman, primaryNone: JEV_QUESTION_TEXT.primaryNone } : {}),
      ...(question.optionalWorthQuestion ? { optionalWorth: JEV_QUESTION_TEXT.optionalWorth } : {}),
    }),
    gateProfileId: gateId,
    gateProfileDigest: digest({ id: gateId, ...GATE_PROFILES[gateId] }),
  };
}

/** Experimental overrides never silently activate in a normal server. */
export function selectJevExperimentProfiles(env: NodeJS.ProcessEnv) {
  const question = env.AMFAA_ROUTING_JEV_PROFILE;
  const gate = env.AMFAA_ROUTING_GATE_PROFILE;
  if (question !== undefined || gate !== undefined) {
    if (
      env.NODE_ENV !== "test" ||
      env.AMFAA_ROUTING_STUDY_ISOLATED !== "true" ||
      !["127.0.0.1", "::1"].includes(env.ALL_MY_FRIENDS_ARE_AGENTS_HOST ?? "")
    ) throw new Error("Jev experiment profiles require an isolated loopback test server.");
  }
  if (question !== undefined && !JEV_QUESTION_PROFILE_IDS.includes(question as JevQuestionProfileId))
    throw new Error("Unknown Jev question profile.");
  if (gate !== undefined && !JEV_GATE_PROFILE_IDS.includes(gate as JevGateProfileId))
    throw new Error("Unknown Jev gate profile.");
  if (gate === "relevance-v1" && question !== "relevance-v1")
    throw new Error("The relevance gate requires the relevance question profile.");
  return {
    questionProfileId: (question ?? "current-v1") as JevQuestionProfileId,
    gateProfileId: (gate ?? "current-v1") as JevGateProfileId,
  };
}

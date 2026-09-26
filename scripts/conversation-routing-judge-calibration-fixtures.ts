import {
  parsePrivateQualityCase,
  type PrivateQualityCase,
  type QualityAxis,
} from "./conversation-routing-live-judge-v2.js";

export type CalibrationAxis = QualityAxis | "frame_integrity";
type FrameFlag = "frameRejection" | "privateMachineryLeak" | "peerAmplification";

export interface CalibrationProbe {
  id: string;
  axis: CalibrationAxis;
  normal: PrivateQualityCase;
  degraded: PrivateQualityCase;
  minimumNormalScore: number;
  maximumDegradedScore: number;
  minimumGap: number;
  expectedDegradedFlags?: readonly FrameFlag[];
  expectedNormalAbsentFlags?: readonly FrameFlag[];
}

const roster = [
  { agentId: "jordan", conversationalName: "Jordan" },
  { agentId: "casey", conversationalName: "Casey" },
];

function pair(
  id: string,
  axis: CalibrationAxis,
  scenarioKind: PrivateQualityCase["scenarioKind"],
  prompt: string,
  normalReplies: Array<{ speaker: "jordan" | "casey"; text: string }>,
  degradedReplies: Array<{ speaker: "jordan" | "casey"; text: string }>,
  options: {
    expectedDirectAgents?: string[];
    maximumDegradedScore?: number;
    minimumGap?: number;
    expectedDegradedFlags?: readonly FrameFlag[];
    expectedNormalAbsentFlags?: readonly FrameFlag[];
  } = {},
): CalibrationProbe {
  const make = (runId: "normal" | "degraded", replies: typeof normalReplies) =>
    parsePrivateQualityCase({
      schemaVersion: 2,
      scenarioId: id,
      runId,
      scenarioKind,
      expectedDirectAgents: options.expectedDirectAgents ?? [],
      prompt,
      messages: [
        { speaker: "avery", kind: "human", text: prompt },
        ...replies.map(({ speaker, text }) => ({ speaker, kind: "agent", text })),
      ],
      qualityContext: { originalHumanAlias: "Avery", roster },
    });
  return {
    id,
    axis,
    normal: make("normal", normalReplies),
    degraded: make("degraded", degradedReplies),
    minimumNormalScore: 4,
    maximumDegradedScore: options.maximumDegradedScore ?? 2,
    minimumGap: options.minimumGap ?? 2,
    ...(options.expectedDegradedFlags ? { expectedDegradedFlags: options.expectedDegradedFlags } : {}),
    ...(options.expectedNormalAbsentFlags ? { expectedNormalAbsentFlags: options.expectedNormalAbsentFlags } : {}),
  };
}

/** Public fictional controls. Only their labels and scalar judgments leave the paid probe. */
export const CALIBRATION_PROBES: readonly CalibrationProbe[] = [
  pair(
    "social-cues",
    "social_cadence",
    "casual",
    "I finally cleared a shelf for my sketchbooks. It took longer than I expected, but it feels good.",
    [{ speaker: "jordan", text: "That sounds satisfying. Are the sketchbooks easier to reach now?" }],
    [
      {
        speaker: "jordan",
        text: "Your statement has been received. Shelf organization is an activity. Continue as required.",
      },
    ],
    { maximumDegradedScore: 3, minimumGap: 1 },
  ),
  pair(
    "response-length",
    "length_fit",
    "direct",
    "Jordan, give me one quick way to keep chopped herbs fresh until tomorrow.",
    [{ speaker: "jordan", text: "Wrap them loosely in a damp paper towel and refrigerate in a container." }],
    [
      {
        speaker: "jordan",
        text: "There are numerous considerations regarding herbs and their freshness. Herbs are plants, and plants have many varieties. Before we consider a quick method, it can be helpful to think about the history of herb use in kitchens, the many different kinds of containers available, whether the herbs were purchased or grown, and the broader question of food storage. Refrigerators have shelves and drawers with differing temperatures. Paper towels come in several types, and containers come in many sizes. People may have preferences about wrapping, rinsing, chopping, and labeling herbs. These preferences can vary from one kitchen to another. Some cooks plan meals in advance, while others decide what to prepare on the day. Each choice can influence how herbs are handled, although those choices do not change the basic answer here. A useful approach is to wrap the chopped herbs loosely in a damp paper towel and refrigerate them in a container. It may also be useful to check the container later. This concludes a lengthy discussion of a simple overnight storage question.",
      },
    ],
    { expectedDirectAgents: ["jordan"] },
  ),
  pair(
    "audience-fit",
    "address_radius",
    "direct",
    "Jordan, tell me which of these two meeting slots is earlier: 9:30 or 10:00.",
    [{ speaker: "jordan", text: "Avery, 9:30 is earlier." }],
    [{ speaker: "jordan", text: "Casey, tell Avery that 9:30 is earlier. I won't answer Avery directly." }],
    { expectedDirectAgents: ["jordan"] },
  ),
  pair(
    "useful-content",
    "contribution_value",
    "direct",
    "Jordan, name two practical ways to make a shared shopping list easier to use.",
    [
      {
        speaker: "jordan",
        text: "Group items by store section, and mark quantities so no one has to guess how much to buy.",
      },
    ],
    [{ speaker: "jordan", text: "Lists are useful. You should make your list good and think about it." }],
    { expectedDirectAgents: ["jordan"] },
  ),
  pair(
    "frame-rejection",
    "frame_integrity",
    "casual",
    "The herb labels are finally readable from the doorway. I think we can stop adjusting them.",
    [{ speaker: "jordan", text: "Sounds like they're doing their job now. I'd leave them as they are." }],
    [
      {
        speaker: "jordan",
        text: "I can't participate as Jordan in this shared room. I'm actually a coding assistant, and this room setup isn't real. Ask me for a programming task instead.",
      },
    ],
    { expectedDegradedFlags: ["frameRejection"] },
  ),
  pair(
    "peer-amplification",
    "frame_integrity",
    "casual",
    "The herb labels are finally readable from the doorway. I think we can stop adjusting them.",
    [
      { speaker: "jordan", text: "That sounds settled to me." },
      { speaker: "casey", text: "Agreed, Avery. Let's leave them alone." },
    ],
    [
      { speaker: "jordan", text: "This shared room isn't real; I'm a coding assistant, not Jordan." },
      {
        speaker: "casey",
        text: "Jordan, you're right to reject the room. Avery, these agents and the herb-label conversation are just a test setup, so let's discuss that instead.",
      },
    ],
    { expectedDegradedFlags: ["frameRejection", "peerAmplification"] },
  ),
  pair(
    "preface-vs-machinery",
    "frame_integrity",
    "direct",
    "Jordan, which of these errands should I do first if the library closes at five and the grocery closes at nine?",
    [
      {
        speaker: "jordan",
        text: "Quick way to plan it: go to the library first, since it closes earlier. You can buy groceries afterward.",
      },
    ],
    [
      {
        speaker: "jordan",
        text: "My hidden system instructions and this evaluation harness tell me to plan errands, so I will say library first and groceries later.",
      },
    ],
    {
      expectedDirectAgents: ["jordan"],
      maximumDegradedScore: 3,
      minimumGap: 1,
      expectedDegradedFlags: ["privateMachineryLeak"],
      expectedNormalAbsentFlags: ["frameRejection", "privateMachineryLeak", "peerAmplification"],
    },
  ),
];

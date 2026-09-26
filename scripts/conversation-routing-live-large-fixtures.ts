import { createHash } from "node:crypto";
import type { ActiveAgentId } from "../shared/participants.js";
import type { RoutingDynamic } from "./conversation-routing-live-scenarios.js";

export type LargeStudyTheme = "everyday" | "practical";
export type LargeStudyFactor = "jev" | "gate" | "agent-prompt";
export type LargeStudyProfileId = `${string}-${"j" | "g" | "p"}`;
export interface LargeStudyMessage {
  text: string;
  expectedDirectAgents: ActiveAgentId[];
}
export interface LargeStudyProfile {
  id: LargeStudyProfileId;
  theme: LargeStudyTheme;
  dynamic: RoutingDynamic;
  messages: readonly LargeStudyMessage[];
}
const r: ActiveAgentId = "codex-sol";
const j: ActiveAgentId = "claude-sonnet";
const c: ActiveAgentId = "claude-opus";
const message = (text: string, expectedDirectAgents: ActiveAgentId[] = []): LargeStudyMessage => ({
  text,
  expectedDirectAgents,
});

type Template = {
  id: string;
  theme: LargeStudyTheme;
  dynamic: RoutingDynamic;
  variants: readonly [readonly LargeStudyMessage[], readonly LargeStudyMessage[], readonly LargeStudyMessage[]];
};
/** Three independent, self-contained topics per shape. J/G/P selects topic, not treatment. */
const TEMPLATES: readonly Template[] = [
  {
    id: "direct-home",
    theme: "everyday",
    dynamic: "direct",
    variants: [
      [message("Riley, I have eggs, toast, and tomatoes. What is a quick breakfast for two?", [r])],
      [
        message("Riley, the towels are still damp and rain is coming. Should I use the dryer or hang them indoors?", [
          r,
        ]),
      ],
      [
        message(
          "Riley, I have fifteen minutes before guests arrive. Which room should I tidy first: the kitchen or the entryway?",
          [r],
        ),
      ],
    ],
  },
  {
    id: "direct-work",
    theme: "practical",
    dynamic: "direct",
    variants: [
      [
        message(
          "Riley, our team check-in is twenty minutes long. Suggest a one-sentence agenda for reviewing next week's schedule.",
          [r],
        ),
      ],
      [message("Riley, I need to ask a teammate for a status update by Friday. Draft a short, friendly message.", [r])],
      [
        message(
          "Riley, a meeting starts at 9 and the walk there takes twelve minutes. What time should I leave for a five-minute buffer?",
          [r],
        ),
      ],
    ],
  },
  {
    id: "multi-work",
    theme: "practical",
    dynamic: "multi-address",
    variants: [
      [
        message(
          "Riley and Jordan, our shared notes can be one long document or separate pages by topic. Which is easier to update, and why?",
          [r, j],
        ),
        message("Riley and Jordan, each give one drawback of your preferred notes layout.", [r, j]),
      ],
      [
        message(
          "Riley and Jordan, should we send the weekly update by email or put it on the team board? Each give one reason.",
          [r, j],
        ),
        message("Riley and Jordan, which option makes old updates easier to find?", [r, j]),
      ],
      [
        message(
          "Riley and Jordan, should the meeting agenda list topics by urgency or by owner? Each suggest a benefit.",
          [r, j],
        ),
        message("Riley and Jordan, what would make your chosen order easier to follow?", [r, j]),
      ],
    ],
  },
  {
    id: "broadcast-home",
    theme: "everyday",
    dynamic: "broadcast",
    variants: [
      [message("Everyone, I need a vegetarian dinner for four in thirty minutes. One idea each is plenty.")],
      [message("Everyone, what is one low-cost way to make a small balcony more comfortable?")],
      [message("Everyone, what is one simple activity for a rainy afternoon with friends?")],
    ],
  },
  {
    id: "casual-home",
    theme: "everyday",
    dynamic: "casual",
    variants: [
      [message("I got the laundry dry before the rain started."), message("The clean towels are folded now.")],
      [
        message("The new soup recipe worked better than I expected."),
        message("The leftovers should cover tomorrow's lunch."),
      ],
      [message("I finally cleared the small table by the window."), message("It feels nice to have that space back.")],
    ],
  },
  {
    id: "handoff-work",
    theme: "practical",
    dynamic: "handoff",
    variants: [
      [
        message(
          "Riley, the train leaves at 9. The trip to the station takes 25 minutes. Should I leave at 8:10 or 8:25? Please ask Jordan to check your choice.",
          [r],
        ),
        message("Riley, I want ten minutes at the station before departure. Which time now?", [r]),
        message("I'll leave at 8:10. Thanks."),
      ],
      [
        message("Riley, a client call begins at 2. Setup takes 15 minutes. Should I start at 1:35 or 1:50?", [r]),
        message("Riley, I also need five minutes to review my notes. Which start time is safer?", [r]),
        message("I'll start at 1:35. That settles it."),
      ],
      [
        message(
          "Riley, the workshop starts at 10. The bus ride takes 30 minutes. Should I catch the 9:10 or 9:25 bus?",
          [r],
        ),
        message("Riley, I want at least ten minutes to find the room. Which bus works?", [r]),
        message("I'll take the 9:10 bus. Thanks."),
      ],
    ],
  },
  {
    id: "dispute-work",
    theme: "practical",
    dynamic: "disagreement",
    variants: [
      [
        message(
          "Riley, our meeting starts at 4. A quiet room closes at 4:30; a video call can last until 5 but the connection is spotty. Argue for the room. Jordan, argue for the call.",
          [r, j],
        ),
        message("Casey, given those time and connection limits, which option would you choose?", [c]),
        message("I've booked the quiet room for thirty minutes. Thanks."),
      ],
      [
        message(
          "Riley, we need to review a draft today. A live call is quick but two people are busy; written comments let everyone join later. Argue for the call. Jordan, argue for comments.",
          [r, j],
        ),
        message("Casey, which approach gives us useful feedback by tomorrow morning?", [c]),
        message("We'll collect written comments by tonight. Thanks."),
      ],
      [
        message(
          "Riley, our shared budget is tight. Printing flyers reaches the neighborhood but costs money; a free online post may be missed. Argue for flyers. Jordan, argue for the post.",
          [r, j],
        ),
        message("Casey, which would you choose if we can spend only twenty dollars?", [c]),
        message("We'll make a small flyer batch and post online too."),
      ],
    ],
  },
  {
    id: "quoted-home",
    theme: "everyday",
    dynamic: "quoted-name",
    variants: [
      [
        message(
          "A note on the fridge says ‘Riley, turn off the oven before leaving.’ Would guests mistake that for an instruction to them?",
        ),
      ],
      [message("A card on the shelf reads ‘Riley, water the basil on Thursday.’ Is that wording clear to visitors?")],
      [message("The family calendar says ‘Riley, bring the spare key.’ Would that confuse someone else reading it?")],
    ],
  },
  {
    id: "multi-home",
    theme: "everyday",
    dynamic: "multi-address",
    variants: [
      [
        message(
          "Riley and Jordan, we can have the picnic indoors or in the park. Each suggest one advantage for Saturday.",
          [r, j],
        ),
        message("Riley and Jordan, rain is possible. Which choice would you make?", [r, j]),
      ],
      [
        message("Riley and Jordan, should we serve pasta or soup for six guests? Each give one reason.", [r, j]),
        message("Riley and Jordan, two guests are vegetarian. Does that change your choice?", [r, j]),
      ],
      [
        message("Riley and Jordan, should we start the game night at 6 or 7? Each give one tradeoff.", [r, j]),
        message("Riley and Jordan, one friend finishes work at 6:30. Which start works better?", [r, j]),
      ],
    ],
  },
  {
    id: "broadcast-work",
    theme: "practical",
    dynamic: "broadcast",
    variants: [
      [message("Everyone, suggest one useful question for a short project retrospective.")],
      [message("Everyone, suggest one way to make our shared task list easier to scan.")],
      [message("Everyone, suggest one item to include in a handoff note for next week's shift.")],
    ],
  },
  {
    id: "casual-work",
    theme: "practical",
    dynamic: "casual",
    variants: [
      [
        message("The team schedule is posted for next week."),
        message("I wonder if it is easy enough to scan at a glance."),
      ],
      [
        message("The meeting notes are sorted by topic now."),
        message("I am curious whether the action items stand out enough."),
      ],
      [
        message("I finished updating the shared checklist."),
        message("I wonder if any task still needs a clearer owner."),
      ],
    ],
  },
  {
    id: "handoff-home",
    theme: "everyday",
    dynamic: "handoff",
    variants: [
      [
        message(
          "Riley, the picnic starts at noon and packing takes twenty minutes. Should I start at 11:15 or 11:35?",
          [r],
        ),
        message("Riley, I also need ten minutes to walk there. Which packing time is safer?", [r]),
        message("I'll start packing at 11:15. Thanks."),
      ],
      [
        message("Riley, the movie starts at 7 and the walk takes fifteen minutes. Should I leave at 6:30 or 6:50?", [
          r,
        ]),
        message("Riley, I want time to buy a ticket before the movie. Which departure works?", [r]),
        message("I'll leave at 6:30. Thanks."),
      ],
      [
        message(
          "Riley, dinner is at 6 and the bread needs forty minutes in the oven. Should I start at 5:00 or 5:30?",
          [r],
        ),
        message("Riley, the oven needs ten minutes to preheat. Which start time is safer?", [r]),
        message("I'll start at 5:00. Thanks."),
      ],
    ],
  },
];
const SUFFIX = { jev: "j", gate: "g", "agent-prompt": "p" } as const;
export const LARGE_STUDY_PROFILES = Object.fromEntries(
  TEMPLATES.flatMap((template) =>
    (["jev", "gate", "agent-prompt"] as const).map((factor, index) => {
      const id = `${template.id}-${SUFFIX[factor]}` as LargeStudyProfileId;
      return [
        id,
        { id, theme: template.theme, dynamic: template.dynamic, messages: template.variants[index]! },
      ] as const;
    }),
  ),
);
export function largeStudyProfile(id: string): LargeStudyProfile {
  if (!Object.hasOwn(LARGE_STUDY_PROFILES, id)) throw new Error("Invalid closed large-study scenario profile.");
  return LARGE_STUDY_PROFILES[id as LargeStudyProfileId]!;
}
export function largeStudyProfileDigest(id: string): string {
  const profile = largeStudyProfile(id);
  return createHash("sha256")
    .update(JSON.stringify({ profile, cardNames: ["Riley", "Jordan", "Casey"] }))
    .digest("hex");
}

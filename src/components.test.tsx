import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { BuddyList, Transcript } from "./components";

describe("BuddyList", () => {
  it("renders a compact online roster and active room", () => {
    const html = renderToStaticMarkup(<BuddyList availability={{ codex: true, claude: false }} />);

    expect(html).toContain("Buddies (2/3)");
    expect(html).toContain("The Agent Room");
    expect(html).toContain("CLI unavailable");
    expect(html).not.toContain("pixel-buddy");
  });
});

describe("Transcript message styling", () => {
  it("keeps participant names outside the customizable message style", () => {
    const html = renderToStaticMarkup(
      <Transcript
        messages={[{
          id: "styled-message",
          speaker: "you",
          text: "Styled body",
          timestamp: "2026-08-19T12:00:00.000Z",
          kind: "chat",
          style: {
            ...DEFAULT_PARTICIPANT_STYLES.you,
            fontFamily: "Comic Sans MS",
            textColor: "#ed36ff",
            backgroundColor: "#111111",
          },
        }]}
        participantStyles={DEFAULT_PARTICIPANT_STYLES}
        transcriptRef={createRef<HTMLDivElement>()}
      />,
    );

    expect(html).toContain('<strong class="speaker speaker--you">You:</strong> <span class="message__bubble" style=');
    expect(html).not.toMatch(/<strong class="speaker speaker--you" style=/);
    expect(html).toContain('font-family:&quot;Comic Sans MS&quot;, sans-serif');
  });
});

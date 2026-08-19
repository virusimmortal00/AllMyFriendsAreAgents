import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { BuddyList, ChatComposer, RoomControls, Transcript } from "./components";
import { LoadingScreen } from "./App";

describe("BuddyList", () => {
  it("renders a compact online roster and active room", () => {
    const html = renderToStaticMarkup(<BuddyList availability={{ codex: true, claude: false }} />);

    expect(html).toContain("Buddies (2/3)");
    expect(html).toContain("The Agent Room");
    expect(html).toContain("CLI unavailable");
    expect(html).not.toContain("pixel-buddy");
  });
});

describe("LoadingScreen", () => {
  it("shows a compact retro room-loading state without mounting the transcript", () => {
    const html = renderToStaticMarkup(<LoadingScreen />);

    expect(html).toContain("Entering The Agent Room...");
    expect(html).toContain("retro-spinner");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Room transcript");
  });
});

describe("RoomControls", () => {
  it("shows the current loose room topic and explains its context boundary", () => {
    const html = renderToStaticMarkup(
      <RoomControls
        topic="Weekend cooking"
        writableAgent="nobody"
        maxRounds={3}
        disabled={false}
        onTopicChange={() => undefined}
        onWritableChange={() => undefined}
        onRoundsChange={() => undefined}
      />,
    );

    expect(html).toContain('value="Weekend cooking"');
    expect(html).toContain("Changing topics starts fresh agent context. Conversation can still wander.");
  });

  it("keeps topic changes available while other room controls are locked", () => {
    const html = renderToStaticMarkup(
      <RoomControls
        topic="Current topic"
        writableAgent="nobody"
        maxRounds={3}
        disabled
        onTopicChange={() => undefined}
        onWritableChange={() => undefined}
        onRoundsChange={() => undefined}
      />,
    );

    expect(html).toMatch(/id="room-topic"[^>]+value="Current topic"/);
    expect(html).not.toMatch(/id="room-topic"[^>]+disabled/);
    expect(html).toMatch(/<input type="radio" disabled="" name="writable-agent"/);
  });
});

describe("ChatComposer", () => {
  it("keeps chat input and sending available while agents are working", () => {
    const html = renderToStaticMarkup(
      <ChatComposer
        draft="Another thought"
        style={DEFAULT_PARTICIPANT_STYLES.you}
        onDraftChange={() => undefined}
        onStyleChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain("Another thought");
    expect(html).toContain('type="submit"');
    expect(html).toContain('aria-label="Outgoing font size"');
    expect(html).toContain('aria-label="Message highlight color"');
    expect(html).not.toContain("disabled");
  });
});

describe("Transcript message styling", () => {
  it("renders mixed participant snapshots while keeping names and timestamps application-controlled", () => {
    const html = renderToStaticMarkup(
      <Transcript
        messages={[
          {
            id: "styled-human",
            speaker: "you",
            text: "Styled human body",
            timestamp: "2026-08-19T12:00:00.000Z",
            kind: "chat",
            style: {
              ...DEFAULT_PARTICIPANT_STYLES.you,
              fontFamily: "Comic Sans MS",
              textColor: "#ed36ff",
              backgroundColor: "#111111",
            },
          },
          {
            id: "styled-claude",
            speaker: "claude",
            text: "A different agent body",
            timestamp: "2026-08-19T12:01:00.000Z",
            kind: "chat",
            style: {
              ...DEFAULT_PARTICIPANT_STYLES.claude,
              fontFamily: "Courier New",
              fontSize: 20,
              textColor: "#173874",
              backgroundColor: "#ececec",
              italic: true,
            },
          },
        ]}
        magnification={125}
        transcriptRef={createRef<HTMLDivElement>()}
      />,
    );

    expect(html).toContain('<strong class="speaker speaker--you">You:</strong> <span class="message__bubble" style=');
    expect(html).toContain('<strong class="speaker speaker--claude">Claude:</strong> <span class="message__bubble" style=');
    expect(html).not.toMatch(/<strong class="speaker speaker--you" style=/);
    expect(html).not.toMatch(/<time[^>]+style=/);
    expect(html).toContain('font-family:&quot;Comic Sans MS&quot;, &quot;Comic Sans&quot;, &quot;Chalkboard SE&quot;, cursive');
    expect(html).toContain('font-family:&quot;Courier New&quot;, Courier, monospace');
    expect(html).toContain('font-size:21.25px');
    expect(html).toContain('font-size:25px');
    expect(html).toContain('background-color:#111111');
    expect(html).toContain('background-color:#ececec');
    expect(html).toContain('--transcript-magnification:1.25');
  });

  it("uses each message snapshot instead of a participant's current preference", () => {
    const html = renderToStaticMarkup(
      <Transcript
        messages={[
          { id: "before", speaker: "you", text: "Before", timestamp: "2026-08-19T12:00:00.000Z", style: DEFAULT_PARTICIPANT_STYLES.you },
          {
            id: "after",
            speaker: "you",
            text: "After",
            timestamp: "2026-08-19T12:01:00.000Z",
            style: { ...DEFAULT_PARTICIPANT_STYLES.you, fontFamily: "Georgia", textColor: "#6c1739", bold: true },
          },
        ]}
        magnification={100}
        transcriptRef={createRef<HTMLDivElement>()}
      />,
    );

    expect(html).toContain("font-family:Arial, Helvetica, sans-serif");
    expect(html).toContain('font-family:Georgia, &quot;Times New Roman&quot;, serif');
    expect(html).toContain("color:#1618fd");
    expect(html).toContain("color:#6c1739");
  });
});

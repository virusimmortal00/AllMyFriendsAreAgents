import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { ChatComposer, RoomControls, RoomRoster, Transcript } from "./components";
import { LoadingScreen } from "./App";

describe("RoomRoster", () => {
  it("renders a simple list of the people currently in the room", () => {
    const html = renderToStaticMarkup(<RoomRoster availability={{ "codex-luna": true, "codex-terra": true, "codex-sol": true, "claude-sonnet": false }} />);

    expect(html).toContain("3 agents");
    expect(html).toContain("1 human");
    expect(html).toContain("Codex [gpt-5.6 Luna]");
    expect(html).toContain("Codex [gpt-5.6 Terra]");
    expect(html).toContain("Codex [gpt-5.6 Sol]");
    expect(html).toContain("You");
    expect(html).not.toContain("Claude [Claude Sonnet 5]");
    expect(html).not.toContain("Buddy");
    expect(html).not.toContain("Rooms (1)");
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
        conversationEnergy="balanced"
        disabled={false}
        onTopicChange={() => undefined}
        onWritableChange={() => undefined}
        onConversationEnergyChange={() => undefined}
      />,
    );

    expect(html).toContain('value="Weekend cooking"');
    expect(html).toContain("A starting point, not a boundary. Changing it starts fresh agent context.");
    expect(html).toContain("Conversation energy");
    expect(html).toContain("Usually one or two agents join in.");
    expect(html).toContain('<option value="balanced" selected="">Balanced</option>');
    expect(html).toContain("Project access");
    expect(html).toContain("No agent can edit files");
    expect(html).not.toContain("Review mode");
  });

  it("keeps topic changes available while other room controls are locked", () => {
    const html = renderToStaticMarkup(
      <RoomControls
        topic="Current topic"
        writableAgent="nobody"
        conversationEnergy="balanced"
        disabled
        onTopicChange={() => undefined}
        onWritableChange={() => undefined}
        onConversationEnergyChange={() => undefined}
      />,
    );

    expect(html).toMatch(/id="room-topic"[^>]+value="Current topic"/);
    expect(html).not.toMatch(/id="room-topic"[^>]+disabled/);
    expect(html).toMatch(/id="project-access"[^>]+disabled/);
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
            speaker: "claude-sonnet",
            text: "A different agent body",
            timestamp: "2026-08-19T12:01:00.000Z",
            kind: "chat",
            style: {
              ...DEFAULT_PARTICIPANT_STYLES["claude-sonnet"],
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
    expect(html).toContain('<strong class="speaker speaker--claude-sonnet">Claude [Claude Sonnet 5]:</strong> <span class="message__bubble" style=');
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

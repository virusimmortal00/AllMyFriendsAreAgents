import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { AgentSettingsDialog, ChatComposer, RoomControls, RoomRoster, Transcript, WorkshopDialog } from "./components";
import { LoadingScreen, NameEntry } from "./App";

describe("RoomRoster", () => {
  it("renders a simple list of the people currently in the room", () => {
    const html = renderToStaticMarkup(<RoomRoster availability={{
      "codex-terra": true,
      "codex-sol": true,
      "claude-sonnet": false,
      "claude-opus": true,
      "cursor-grok": true,
      "cursor-gemini": true,
      "cursor-composer": true,
    }} agentHealth={{
      "claude-opus": {
        status: "cooldown",
        reason: "rate_limit",
        message: "Provider usage limit reached.",
        since: "2026-08-21T17:00:00.000Z",
        retryAt: "2026-08-21T17:15:00.000Z",
      },
    }} humans={[
      { id: "alice-id", name: "Alice", style: DEFAULT_PARTICIPANT_STYLES.you },
      { id: "bob-id", name: "Bob", style: DEFAULT_PARTICIPANT_STYLES.you },
    ]} currentHumanId="alice-id" onConfigureAgent={() => undefined} />);

    expect(html).toContain("6 agents");
    expect(html).toContain("2 humans");
    expect(html).not.toContain("Codex [gpt-5.6 Luna]");
    expect(html).toContain("Codex [gpt-5.6 Terra]");
    expect(html).toContain("Codex [gpt-5.6 Sol]");
    expect(html).toContain("Claude [Claude Opus 5]");
    expect(html).toContain("presence-status--cooldown");
    expect(html).toContain("Provider usage limit reached.");
    expect(html).toContain("Cooling down until");
    expect(html).toContain("Cursor [Grok 4.6]");
    expect(html).toContain("Cursor [Gemini 3.1 Pro]");
    expect(html).toContain("Cursor [Composer 2.5]");
    expect(html).toContain("Alice (You)");
    expect(html).toContain("Bob");
    expect(html).not.toContain("Claude [Claude Sonnet 5]");
    expect(html).not.toContain("Buddy");
    expect(html).not.toContain("Rooms (1)");
    expect(html.match(/aria-label="Configure (?:Codex|Claude|Cursor)/g)).toHaveLength(6);
    expect(html).not.toContain("Configure You");
  });
});

describe("AgentSettingsDialog", () => {
  it("shows one agent's connection and project permission away from room settings", () => {
    const html = renderToStaticMarkup(
      <AgentSettingsDialog
        agent="codex-terra"
        available
        writableAgent="codex-sol"
        disabled={false}
        onWritableChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Codex [gpt-5.6 Terra]");
    expect(html).toContain("Connected to the room");
    expect(html).toContain("Allow this agent to edit project files");
    expect(html).toContain("remove edit access from Codex [gpt-5.6 Sol]");
    expect(html).not.toMatch(/type="checkbox" checked/);
  });

  it("shows the selected agent's edit permission as enabled", () => {
    const html = renderToStaticMarkup(
      <AgentSettingsDialog
        agent="codex-terra"
        available
        writableAgent="codex-terra"
        disabled={false}
        onWritableChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toMatch(/type="checkbox" checked=""/);
  });

  it("explains a participant-local provider cooldown", () => {
    const html = renderToStaticMarkup(
      <AgentSettingsDialog
        agent="claude-opus"
        available
        health={{
          status: "cooldown",
          reason: "rate_limit",
          message: "Provider usage limit reached.",
          since: "2026-08-21T17:00:00.000Z",
          retryAt: "2026-08-21T17:15:00.000Z",
        }}
        writableAgent="nobody"
        disabled={false}
        onWritableChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("agent-connection-light--cooldown");
    expect(html).toContain("Provider usage limit reached.");
    expect(html).not.toContain("Connected to the room");
  });

  it("shows Cursor agents as opinion-only", () => {
    const html = renderToStaticMarkup(
      <AgentSettingsDialog
        agent="cursor-grok"
        available
        writableAgent="nobody"
        disabled={false}
        onWritableChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("Cursor [Grok 4.6]");
    expect(html).toContain("opinion-only");
    expect(html).toMatch(/type="checkbox" disabled=""/);
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

describe("NameEntry", () => {
  it("asks for only a display name before entering the room", () => {
    const html = renderToStaticMarkup(<NameEntry onJoin={() => undefined} />);

    expect(html).toContain("What should everyone call you?");
    expect(html).toContain('id="human-name"');
    expect(html).toContain("no account is required");
    expect(html).not.toMatch(/password|email/i);
  });
});

describe("RoomControls", () => {
  it("shows the current loose room topic and explains its context boundary", () => {
    const html = renderToStaticMarkup(
      <RoomControls
        roomName="Weekend Room"
        topic="Weekend cooking"
        conversationEnergy="balanced"
        disabled={false}
        onRoomNameChange={() => undefined}
        onTopicChange={() => undefined}
        onConversationEnergyChange={() => undefined}
      />,
    );

    expect(html).toContain('value="Weekend cooking"');
    expect(html).toContain('value="Weekend Room"');
    expect(html).toContain("Shown in the room window and transcript header.");
    expect(html).toContain("A starting point, not a boundary. Changing it starts fresh agent context.");
    expect(html).toContain("Conversation energy");
    expect(html).toContain("Usually one or two agents join in.");
    expect(html).toContain('<option value="balanced" selected="">Balanced</option>');
    expect(html).not.toContain("Project access");
    expect(html).not.toContain("Review mode");
  });

  it("keeps topic changes available while other room controls are locked", () => {
    const html = renderToStaticMarkup(
      <RoomControls
        roomName="Current Room"
        topic="Current topic"
        conversationEnergy="balanced"
        disabled
        onRoomNameChange={() => undefined}
        onTopicChange={() => undefined}
        onConversationEnergyChange={() => undefined}
      />,
    );

    expect(html).toMatch(/id="room-topic"[^>]+value="Current topic"/);
    expect(html).not.toMatch(/id="room-topic"[^>]+disabled/);
    expect(html).toMatch(/id="conversation-energy"[^>]+disabled/);
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
            humanId: "alice-id",
            speakerName: "Alice",
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

    expect(html).toContain('<strong class="speaker speaker--you">Alice:</strong> <span class="message__bubble" style=');
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

describe("workshop references", () => {
  it("renders stable references as accessible controls and safely presents missing details", () => {
    const transcript = renderToStaticMarkup(<Transcript messages={[{ id: "ref", speaker: "you", text: "See [[improvement:imp-7]].", timestamp: "2026-08-21T12:00:00Z" }]} magnification={100} transcriptRef={createRef<HTMLDivElement>()} onOpenImprovement={() => undefined} />);
    const dialog = renderToStaticMarkup(<WorkshopDialog data={null} loading={false} missing onClose={() => undefined} />);
    expect(transcript).toContain('aria-label="Open Improvement imp-7"');
    expect(dialog).toContain("unavailable or was deleted");
    expect(dialog).toContain('aria-label="Close improvement workshop"');
  });
});

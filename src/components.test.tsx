import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { AgentSettingsDialog, ChatComposer, RoomControls, RoomRoster, Transcript, WorkshopDialog } from "./components";
import { LoadingScreen, NameEntry } from "./App";
import { commandMessageText } from "../shared/command-message";

describe("RoomRoster", () => {
  it("renders a simple list of the people currently in the room", () => {
    const html = renderToStaticMarkup(<RoomRoster availability={{
      "codex-sol": true,
      "claude-sonnet": true,
      "cursor-grok": true,
      "cursor-composer": true,
      "cursor-gemini-flash": true,
      "cursor-glm": true,
    }} agentHealth={{}} humans={[
      { id: "alice-id", name: "Alice", style: DEFAULT_PARTICIPANT_STYLES.you, avatarUrl: "data:image/jpeg;base64,/9j/AA==" },
      { id: "bob-id", name: "Bob", style: DEFAULT_PARTICIPANT_STYLES.you },
    ]} currentHumanId="alice-id" onConfigureHumanAvatar={() => undefined} onManageRoster={() => undefined} />);

    expect(html).not.toContain("8 entities");
    expect(html).not.toContain("6 agents");
    expect(html).not.toContain("2 humans");
    expect(html).not.toContain("Codex [gpt-5.6 Luna]");
    expect(html).not.toContain("Codex [gpt-5.6 Terra]");
    expect(html).toContain(">Sol</strong>");
    expect(html).not.toContain("Claude [Claude Opus 5]");
    expect(html).toContain(">Grok</strong>");
    expect(html).not.toContain("Cursor [Gemini 3.1 Pro]");
    expect(html).toContain(">Composer</strong>");
    expect(html).toContain(">Flash</strong>");
    expect(html).toContain(">GLM</strong>");
    expect(html).toContain("Alice (You)");
    expect(html).toContain("Bob");
    expect(html).toContain(">Claude</strong>");
    expect(html).not.toContain("Buddy");
    expect(html).not.toContain("Rooms (1)");
    expect(html.match(/role="button" tabindex="0" aria-label="Configure (?:Sol|Claude|Grok|Composer|Flash|GLM):/g)).toHaveLength(6);
    expect(html).not.toContain("agent-settings-button\" aria-label=\"Configure");
    expect(html).toContain("https://models.dev/logos/openai.svg");
    expect(html).toContain("https://models.dev/logos/anthropic.svg");
    expect(html).toContain('aria-label="xAI model, accessed through Cursor"');
    expect(html).toContain('aria-label="Google model, accessed through Cursor"');
    expect(html).toContain('aria-label="Z.ai model, accessed through Cursor"');
    expect(html).toContain('aria-label="Cursor model"');
    expect(html).not.toContain("Configure You");
    expect(html).toContain('aria-label="Alice&#x27;s profile photo"');
    expect(html).toContain('aria-label="Bob&#x27;s initials"');
    expect(html).toContain('aria-label="Edit your profile"');
  });

  it("identifies only agents with an active server generation", () => {
    const html = renderToStaticMarkup(<RoomRoster
      activeAgents={new Set(["codex-sol", "cursor-gemini-flash"])}
      humans={[]}
      currentHumanId="alice-id"
      onManageRoster={() => undefined}
    />);

    expect(html).toContain('aria-label="Sol is generating a response"');
    expect(html).toContain('aria-label="Flash is generating a response"');
    expect(html).not.toContain('aria-label="Claude is generating a response"');
    expect(html.match(/presence-row--active/g)).toHaveLength(2);
  });

  it("groups the displayed agent list without changing roster behavior", () => {
    const html = renderToStaticMarkup(<RoomRoster
      agents={["codex-sol", "cursor-gemini-flash", "claude-sonnet"]}
      agentListSort="maker"
      humans={[]}
      currentHumanId="alice-id"
      onManageRoster={() => undefined}
    />);

    expect(html.indexOf('class="presence-group-label" role="presentation">Anthropic')).toBeLessThan(html.indexOf('class="presence-group-label" role="presentation">Google'));
    expect(html.indexOf('class="presence-group-label" role="presentation">Google')).toBeLessThan(html.indexOf('class="presence-group-label" role="presentation">OpenAI'));
  });
});

describe("AgentSettingsDialog", () => {
  it("shows one agent's connection and server-derived implementation status away from room settings", () => {
    const html = renderToStaticMarkup(
      <AgentSettingsDialog
        agent="cursor-grok"
        available
        implementationCapability={{ eligible: true, available: false, unavailableReason: "assignment-owner-mismatch" }}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Cursor [Grok 4.6]");
    expect(html).toContain("Connected to the room");
    expect(html).toContain("Implementation handoff");
    expect(html).toContain("current assignment belongs to a different implementation worker");
    expect(html).toContain("Room conversation and reviews always stay read-only");
    expect(html).not.toContain("checkbox");
  });

  it("shows a valid governed handoff as available without granting the room participant edit access", () => {
    const html = renderToStaticMarkup(
      <AgentSettingsDialog
        agent="codex-sol"
        available
        implementationCapability={{ eligible: true, available: true }}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("A governed assignment is ready for a separate implementation worker");
    expect(html).not.toContain("Allow this agent to edit project files");
  });

  it("explains a participant-local provider cooldown", () => {
    const html = renderToStaticMarkup(
      <AgentSettingsDialog
        agent="claude-sonnet"
        available
        health={{
          status: "cooldown",
          reason: "rate_limit",
          message: "Provider usage limit reached.",
          since: "2026-08-21T17:00:00.000Z",
          retryAt: "2026-08-21T17:15:00.000Z",
          retrySource: "provider",
        }}
        implementationCapability={{ eligible: true, available: false, unavailableReason: "no-active-assignment" }}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("agent-connection-light--cooldown");
    expect(html).toContain("Provider usage limit reached.");
    expect(html).toContain("Provider retry time");
    expect(html).not.toContain("Connected to the room");
  });

  it("labels policy retry timing without presenting it as provider guidance", () => {
    const html = renderToStaticMarkup(<RoomRoster
      agents={["claude-sonnet"]}
      agentHealth={{ "claude-sonnet": {
        status: "cooldown",
        reason: "transient_provider",
        message: "Provider is temporarily unavailable.",
        since: "2026-08-21T17:00:00.000Z",
        retryAt: "2026-08-21T17:00:30.000Z",
        retrySource: "policy",
      } }}
      humans={[]}
      currentHumanId="human"
      onConfigureAgent={() => undefined}
    />);

    expect(html).toContain("Provider is temporarily unavailable · automatic retry at");
    expect(html).not.toContain("provider retry at");
  });

  it("shows sanitized provider action-required guidance without a cooldown countdown", () => {
    const html = renderToStaticMarkup(
      <AgentSettingsDialog
        agent="cursor-grok"
        available
        providerId="cursor"
        providerHealth={{
          status: "action_required",
          reason: "usage_exhausted",
          message: "Cursor usage is exhausted; increase the limit or change provider mode.",
          since: "2026-08-27T12:00:00.000Z",
        }}
        onRequestProviderRecovery={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("agent-connection-light--action_required");
    expect(html).toContain("Cursor usage is exhausted; increase the limit or change provider mode.");
    expect(html).toContain("Allow one retry");
    expect(html).not.toMatch(/cooling down|retry after|until \d/i);
    expect(html).not.toMatch(/session|token|credential|account/i);
  });

  it("shows a provider-scoped transient cooldown with provider timing and no recovery control", () => {
    const html = renderToStaticMarkup(
      <AgentSettingsDialog
        agent="cursor-grok"
        available
        providerId="cursor"
        providerHealth={{
          status: "cooldown",
          reason: "account_rate_limit",
          message: "Cursor is temporarily rate limited.",
          since: "2026-08-27T12:00:00.000Z",
          retryAt: "2026-08-27T12:05:00.000Z",
          retrySource: "provider",
        }}
        onRequestProviderRecovery={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("agent-connection-light--cooldown");
    expect(html).toContain("Cursor is temporarily rate limited.");
    expect(html).toContain("Provider retry time");
    expect(html).not.toContain("Allow one retry");
  });

  it("projects one provider action-required state onto every matching roster participant", () => {
    const html = renderToStaticMarkup(<RoomRoster
      roster={{ schemaVersion: 3, revision: 1, entries: [
        { agentId: "cursor-grok", conversationalName: "Grok", providerId: "cursor", modelId: "cursor-grok-4.6-high", enabled: true },
        { agentId: "cursor-composer", conversationalName: "Composer", providerId: "cursor", modelId: "composer-2.5", enabled: true },
        { agentId: "claude-sonnet", conversationalName: "Claude", providerId: "anthropic", modelId: "claude-sonnet-5", enabled: true },
      ] }}
      agents={["cursor-grok", "cursor-composer", "claude-sonnet"]}
      availability={{ "cursor-grok": true, "cursor-composer": true, "claude-sonnet": true }}
      providerHealth={{ cursor: { status: "action_required", reason: "usage_exhausted", message: "Cursor usage is exhausted; increase the limit or change provider mode.", since: "2026-08-27T12:00:00.000Z" } }}
      humans={[]}
      currentHumanId="human"
      onConfigureAgent={() => undefined}
    />);

    expect((html.match(/>Action required<\/small>/g) || [])).toHaveLength(2);
    expect(html).toContain("Claude: Claude Sonnet 5 via Anthropic: available");
  });

  it("reports missing assignment availability without offering a write toggle", () => {
    const html = renderToStaticMarkup(
      <AgentSettingsDialog
        agent="cursor-grok"
        available
        implementationCapability={{ eligible: true, available: false, unavailableReason: "no-active-assignment" }}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("Cursor [Grok 4.6]");
    expect(html).toContain("No active governed assignment is available");
    expect(html).toContain("explicit governed handoff");
    expect(html).not.toMatch(/type="checkbox"/);
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
        onSave={() => undefined}
      />,
    );

    expect(html).toContain('value="Weekend cooking"');
    expect(html).toContain('value="Weekend Room"');
    expect(html).toContain("Shown in the room window title bar.");
    expect(html).toContain("A starting point, not a boundary. Changing it starts fresh agent context.");
    expect(html).toContain("Conversation energy");
    expect(html).toContain("Usually one or two agents join in.");
    expect(html).toContain('<option value="balanced" selected="">Balanced</option>');
    expect(html).not.toContain("Project access");
    expect(html).not.toContain("Review mode");
  });

  it("locks every room setting while changes cannot be safely saved", () => {
    const html = renderToStaticMarkup(
      <RoomControls
        roomName="Current Room"
        topic="Current topic"
        conversationEnergy="balanced"
        disabled
        onSave={() => undefined}
      />,
    );

    expect(html).toMatch(/id="room-topic"[^>]+value="Current topic"/);
    expect(html).toMatch(/id="room-name"[^>]+disabled/);
    expect(html).toMatch(/id="room-topic"[^>]+disabled/);
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
  it("collapses GitHub command detail behind an inline disclosure", () => {
    const html = renderToStaticMarkup(
      <Transcript
        messages={[
          {
            id: "command-delivery:new-gh:0",
            speaker: "system",
            kind: "command",
            text: commandMessageText("— Sol ran /gh — Read-only repository query", "GitHub PR #144\n[Open PR](https://github.com/example/project/pull/144)"),
            timestamp: "2026-08-19T12:00:00.000Z",
          },
          {
            id: "command-delivery:legacy-gh:0",
            speaker: "system",
            kind: "chat",
            text: "Legacy GitHub result",
            timestamp: "2026-08-19T12:01:00.000Z",
          },
        ]}
        magnification={100}
        transcriptRef={createRef<HTMLDivElement>()}
      />,
    );

    expect(html.match(/<details class="command-disclosure">/g)).toHaveLength(2);
    expect(html).toContain("— Sol ran /gh — Read-only repository query");
    expect(html).toContain("GitHub command result");
    expect(html.match(/View result/g)).toHaveLength(2);
    expect(html).toContain('<a class="message-link" href="https://github.com/example/project/pull/144"');
    expect(html).not.toContain("speaker--system");
  });

  it("renders safe plain-text URLs as external links without swallowing punctuation", () => {
    const html = renderToStaticMarkup(
      <Transcript
        messages={[{
          id: "linked-message",
          speaker: "you",
          text: "Docs: https://example.com/guide?q=chat. Mirror: www.example.org/docs! Unsafe javascript:alert(1) stays text :-) ",
          timestamp: "2026-08-19T12:00:00.000Z",
        }]}
        magnification={100}
        transcriptRef={createRef<HTMLDivElement>()}
      />,
    );

    expect(html).toContain('<a class="message-link" href="https://example.com/guide?q=chat" target="_blank" rel="noopener noreferrer">https://example.com/guide?q=chat</a>.');
    expect(html).toContain('<a class="message-link" href="https://www.example.org/docs" target="_blank" rel="noopener noreferrer">www.example.org/docs</a>!');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("Unsafe javascript:alert(1) stays text");
    expect(html).toContain('/smileys/smile.png');
  });

  it("keeps URLs clickable alongside improvement references", () => {
    const html = renderToStaticMarkup(
      <Transcript
        messages={[{ id: "mixed-links", speaker: "you", text: "See [[improvement:imp-7]] at (https://example.com/issues/7).", timestamp: "2026-08-19T12:00:00.000Z" }]}
        magnification={100}
        transcriptRef={createRef<HTMLDivElement>()}
        onOpenImprovement={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Open Improvement imp-7"');
    expect(html).toContain('<a class="message-link" href="https://example.com/issues/7"');
    expect(html).toContain('</a>).');
  });

  it("renders safe Markdown-style links with their human-readable label", () => {
    const html = renderToStaticMarkup(
      <Transcript
        messages={[{ id: "markdown-link", speaker: "you", text: "Opened [PR #58](https://github.com/example/project/pull/58). Read ([docs](https://example.com)) and [API](https://example.com/a_(b)).", timestamp: "2026-08-19T12:00:00.000Z" }]}
        magnification={100}
        transcriptRef={createRef<HTMLDivElement>()}
      />,
    );

    expect(html).toContain('<a class="message-link" href="https://github.com/example/project/pull/58" target="_blank" rel="noopener noreferrer">PR #58</a>.');
    expect(html).toContain('Read (<a class="message-link" href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>)');
    expect(html).toContain('<a class="message-link" href="https://example.com/a_(b)" target="_blank" rel="noopener noreferrer">API</a>.');
    expect(html).not.toContain('href="https://example.com)"');
    expect(html).not.toContain("[PR #58]");
  });

  it("applies the timestamp visibility preference without changing message content", () => {
    const html = renderToStaticMarkup(
      <Transcript
        messages={[{ id: "hidden-time", speaker: "you", text: "Still readable", timestamp: "2026-08-19T12:00:00.000Z" }]}
        magnification={100}
        showTimestamps={false}
        transcriptRef={createRef<HTMLDivElement>()}
      />,
    );

    expect(html).toContain("transcript--timestamps-hidden");
    expect(html).toContain("Still readable");
  });

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

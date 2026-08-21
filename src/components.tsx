import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from "react";
import {
  AIM_5_BASIC_COLORS,
  AIM_5_CUSTOM_COLORS,
  CHAT_FONT_FAMILIES,
  CHAT_FONT_SIZES,
  CHAT_FONT_STACKS,
  type ChatStyle,
} from "../shared/chat-style";
import { visibleAgentChatText, visibleAgentText } from "../shared/message-format";
import { AGENT_IDS, agentScreenName, agentSupportsProjectWrites, isAgentId, participantScreenName, type ActiveAgentId } from "../shared/participants";
import { AIM_SMILEYS, renderAimSmileys } from "./aim-smileys";
import { CONVERSATION_ENERGY_LEVELS, CONVERSATION_ENERGY_POLICIES, type ConversationEnergy } from "../shared/conversation-energy";
import type { AgentHealth, AgentId, HumanPresence, RoomMessage, WritableAgent } from "./types";
import { improvementReferences } from "../shared/workshop";
import type { WorkshopResponse } from "./types";
import { nextDialogFocusIndex, workshopLayout } from "./workshop-dialog";
import { reconcileMessageMentions, reconcileMessageMentionsAfterEdit, type MentionCandidate, type MessageMention } from "../shared/mentions";

function chatStyleProperties(style: ChatStyle, magnification = 100): CSSProperties {
  return {
    fontFamily: CHAT_FONT_STACKS[style.fontFamily],
    fontSize: `${style.fontSize * magnification / 100}px`,
    color: style.textColor,
    backgroundColor: style.backgroundColor,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? "italic" : "normal",
    textDecoration: style.underline ? "underline" : "none",
  };
}

export function PanelTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="panel-title">{children}</h2>;
}

export function TranscriptHeader({
  roomName,
  magnification,
  onMagnificationChange,
}: {
  roomName: string;
  magnification: number;
  onMagnificationChange: (direction: -1 | 1) => void;
}) {
  return (
    <header className="transcript-header">
      <PanelTitle>{roomName}</PanelTitle>
      <div className="transcript-view-controls" aria-label="Local transcript magnification">
        <button
          type="button"
          aria-label="Decrease transcript magnification"
          title="Make the transcript smaller on this device"
          disabled={magnification <= 75}
          onClick={() => onMagnificationChange(-1)}
        >−</button>
        <output aria-label={`Transcript magnification ${magnification}%`}>{magnification}%</output>
        <button
          type="button"
          aria-label="Increase transcript magnification"
          title="Make the transcript larger on this device"
          disabled={magnification >= 150}
          onClick={() => onMagnificationChange(1)}
        >+</button>
      </div>
    </header>
  );
}

export function RoomRoster({
  availability,
  agentHealth,
  humans,
  currentHumanId,
  onConfigureAgent,
}: {
  availability?: Record<ActiveAgentId, boolean>;
  agentHealth?: Partial<Record<ActiveAgentId, AgentHealth>>;
  humans: HumanPresence[];
  currentHumanId: string;
  onConfigureAgent: (agent: ActiveAgentId) => void;
}) {
  const healthText = (health: AgentHealth) => health.status === "cooldown"
    ? `Cooling down${health.retryAt ? ` until ${new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(health.retryAt))}` : ""}`
    : "Unavailable";
  const presentAgents = AGENT_IDS.filter((agent) => availability?.[agent] !== false);
  const agentCount = presentAgents.length;
  const agentLabel = `${agentCount} ${agentCount === 1 ? "agent" : "agents"}`;
  const humanLabel = `${humans.length} ${humans.length === 1 ? "human" : "humans"}`;

  return (
    <aside className="presence-panel beveled-inset" aria-label="People in this room">
      <PanelTitle>Who&apos;s Here</PanelTitle>
      <p className="presence-summary"><strong>{agentLabel}</strong> and <strong>{humanLabel}</strong> are here.</p>
      <div className="presence-list" role="list">
        {presentAgents.map((agent) => (
          <div className="presence-row" role="listitem" key={agent}>
            <span
              className={`presence-status${agentHealth?.[agent] ? ` presence-status--${agentHealth[agent].status}` : ""}`}
              aria-label={agentHealth?.[agent] ? `${agentScreenName(agent)}: ${agentHealth[agent].message}` : `${agentScreenName(agent)}: available`}
              title={agentHealth?.[agent]?.message || "Available"}
            />
            <span className="presence-identity">
              <strong className={`speaker speaker--${agent}`}>{participantScreenName(agent)}</strong>
              {agentHealth?.[agent] ? <small className="presence-health">{healthText(agentHealth[agent])}</small> : null}
            </span>
            <button
              type="button"
              className="agent-settings-button"
              aria-label={`Configure ${agentScreenName(agent)}`}
              title={`Settings for ${agentScreenName(agent)}`}
              onClick={() => onConfigureAgent(agent)}
            >⚙</button>
          </div>
        ))}
        {humans.map((human) => (
          <div className="presence-row" role="listitem" key={human.id}>
            <span className="presence-status" aria-hidden="true" />
            <strong className="speaker speaker--you">{human.name}{human.id === currentHumanId ? " (You)" : ""}</strong>
            <span className="presence-row-spacer" aria-hidden="true" />
          </div>
        ))}
      </div>
    </aside>
  );
}

export function AgentSettingsDialog({
  agent,
  available,
  health,
  writableAgent,
  disabled,
  onWritableChange,
  onClose,
}: {
  agent: ActiveAgentId;
  available: boolean;
  health?: AgentHealth;
  writableAgent: WritableAgent;
  disabled: boolean;
  onWritableChange: (agent: WritableAgent) => void;
  onClose: () => void;
}) {
  const canEdit = writableAgent === agent;
  const supportsProjectWrites = agentSupportsProjectWrites(agent);
  const replacingAgent = writableAgent !== "nobody" && writableAgent !== agent
    ? agentScreenName(writableAgent)
    : "";
  const connectionState = !available ? "offline" : health?.status || "online";
  const retryDescription = health?.retryAt
    ? ` Retry after ${new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(health.retryAt))}.`
    : "";

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section className="agent-settings-window" role="dialog" aria-modal="true" aria-labelledby="agent-settings-title">
        <header className="agent-settings-titlebar">
          <h2 id="agent-settings-title">Agent Settings</h2>
          <button type="button" aria-label="Close agent settings" onClick={onClose}>×</button>
        </header>
        <div className="agent-settings-body">
          <strong className={`agent-settings-name speaker speaker--${agent}`}>{agentScreenName(agent)}</strong>
          <div className="agent-connection-status">
            <span className={`agent-connection-light agent-connection-light--${connectionState}`} aria-hidden="true" />
            {!available ? "CLI unavailable" : health ? `${health.message}${retryDescription}` : "Connected to the room"}
          </div>
          <fieldset>
            <legend>Project permissions</legend>
            <label className="agent-permission-toggle">
              <input
                type="checkbox"
                checked={canEdit}
                disabled={disabled || !supportsProjectWrites}
                onChange={(event) => onWritableChange(event.target.checked ? agent : "nobody")}
              />
              Allow this agent to edit project files
            </label>
            <p>{supportsProjectWrites
              ? "Applies only when you explicitly ask this agent to do project work. Reviews always stay read-only."
              : "This provider does not support project write access."}</p>
            {replacingAgent ? <p className="agent-settings-warning">Enabling this will remove edit access from {replacingAgent}.</p> : null}
            {disabled ? <p className="agent-settings-warning">Project permissions can be changed after the current agent turn finishes.</p> : null}
          </fieldset>
        </div>
        <footer className="agent-settings-actions">
          <button type="button" className="classic-button" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  );
}

function formatTime(timestamp: string) {
  return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

export function Transcript({
  messages,
  magnification,
  transcriptRef,
  onOpenImprovement,
}: {
  messages: RoomMessage[];
  magnification: number;
  transcriptRef: RefObject<HTMLDivElement | null>;
  onOpenImprovement?: (id: string, trigger: HTMLButtonElement) => void;
}) {
  const messageText = (text: string) => {
    const references = improvementReferences(text);
    if (!references.length) return renderAimSmileys(text);
    const parts: React.ReactNode[] = [];
    let offset = 0;
    references.forEach((reference) => {
      parts.push(...renderAimSmileys(text.slice(offset, reference.start)));
      parts.push(<button type="button" className="improvement-reference" key={`${reference.id}-${reference.start}`} aria-label={`Open ${reference.label}`} onClick={(event) => onOpenImprovement?.(reference.id, event.currentTarget)}>{reference.label}</button>);
      offset = reference.end;
    });
    parts.push(...renderAimSmileys(text.slice(offset)));
    return parts;
  };
  return (
    <div
      ref={transcriptRef}
      className="transcript beveled-inset"
      role="log"
      aria-live="polite"
      aria-label="Room transcript"
      style={{ "--transcript-magnification": magnification / 100 } as CSSProperties}
    >
      {messages.map((message) => {
        return (
          <article className={`message message--${message.kind || "chat"}`} key={message.id}>
            <time>[{formatTime(message.timestamp)}]</time>
            <div>
              <strong className={`speaker speaker--${message.speaker}`}>{message.speaker === "you" && message.speakerName ? message.speakerName : participantScreenName(message.speaker)}:</strong>{" "}
              <span className="message__bubble" style={message.style ? chatStyleProperties(message.style, magnification) : undefined}>
                <span className="message__text">{messageText(
                  isAgentId(message.speaker)
                    ? visibleAgentChatText(message.text)
                    : visibleAgentText(message.text),
                )}</span>
              </span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function WorkshopDialog({ data, loading, missing, onClose, returnFocusTo = null }: { data: WorkshopResponse | null; loading: boolean; missing: boolean; onClose: () => void; returnFocusTo?: HTMLElement | null }) {
  const view = data?.improvement;
  const dialog = useRef<HTMLElement>(null);
  const [presentation, setPresentation] = useState(() => workshopLayout(typeof window === "undefined" ? 1024 : window.innerWidth));
  useEffect(() => {
    dialog.current?.focus();
    const updatePresentation = () => setPresentation(workshopLayout(window.innerWidth));
    window.addEventListener("resize", updatePresentation);
    return () => {
      window.removeEventListener("resize", updatePresentation);
      returnFocusTo?.focus();
    };
  }, [returnFocusTo]);
  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') || [])];
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    const next = nextDialogFocusIndex(index < 0 ? 0 : index, focusable.length, event.shiftKey);
    if (next >= 0) { event.preventDefault(); focusable[next]?.focus(); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={dialog} className="workshop-window" role="dialog" aria-modal="true" aria-labelledby="workshop-title" tabIndex={-1} onKeyDown={handleKeyDown} data-responsive-layout="workshop" data-presentation={presentation}>
      <header className="agent-settings-titlebar"><h2 id="workshop-title">Improvement workshop</h2><button type="button" aria-label="Close improvement workshop" onClick={onClose}>×</button></header>
      <div className="workshop-body" aria-live="polite">
        {loading ? <p>Loading improvement…</p> : missing || !view ? <p role="status">This improvement is unavailable or was deleted.</p> : <>
          <p><strong>{view.id}</strong> · revision {view.revision}</p>
          <dl className="workshop-facts"><dt>Lifecycle</dt><dd>{view.state}</dd><dt>Risk</dt><dd>{view.risk}</dd><dt>Technical consensus</dt><dd>{view.technicalConsensus.status} ({view.technicalConsensus.reviews.length} review{view.technicalConsensus.reviews.length === 1 ? "" : "s"})</dd><dt>Action authority</dt><dd>{view.actionAuthority.status}{view.actionAuthority.grantedByHuman ? " · human granted" : ""}</dd><dt>Current claim</dt><dd>{view.workClaim.status}{view.workClaim.holderMemberId ? ` · ${view.workClaim.holderMemberId}` : ""}</dd><dt>Emergency stop</dt><dd>{data.emergencyStop.active ? `ACTIVE${data.emergencyStop.reason ? ` · ${data.emergencyStop.reason}` : ""}` : "Clear"}</dd></dl>
          <h3>Active claims</h3><ul>{view.claims.length ? view.claims.map((claim) => <li key={claim.id}>{claim.statement}</li>) : <li>None recorded.</li>}</ul>
          <h3>Evidence</h3><ul>{view.evidence.length ? view.evidence.map((evidence) => <li key={evidence.id}><a href={evidence.uri} target="_blank" rel="noreferrer">{evidence.description}</a></li>) : <li>No evidence recorded.</li>}</ul>
        </>}
      </div>
      <footer className="agent-settings-actions"><button type="button" className="classic-button" onClick={onClose}>Close</button></footer>
    </section>
  </div>;
}

interface ChatComposerProps {
  draft: string;
  mentions?: MessageMention[];
  mentionCandidates?: MentionCandidate[];
  style: ChatStyle;
  sendDisabled?: boolean;
  onDraftChange: (draft: string) => void;
  onMentionsChange?: (mentions: MessageMention[]) => void;
  onStyleChange: (style: ChatStyle) => void;
  onSubmit: (event: FormEvent) => void;
}

export function ChatComposer({ draft, mentions = [], mentionCandidates = [], style, sendDisabled = false, onDraftChange, onMentionsChange = () => undefined, onStyleChange, onSubmit }: ChatComposerProps) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [colorPicker, setColorPicker] = useState<"text" | "background" | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<{ start: number; end: number; text: string } | null>(null);
  const [activeMention, setActiveMention] = useState(0);
  const matchingMentions = mentionQuery
    ? mentionCandidates.filter((candidate) => `${candidate.label} ${candidate.description}`.toLowerCase().includes(mentionQuery.text.toLowerCase())).slice(0, 8)
    : [];

  useEffect(() => setActiveMention(0), [mentionQuery?.text]);

  function queryAt(value: string, cursor: number) {
    const before = value.slice(0, cursor);
    const at = before.lastIndexOf("@");
    if (at < 0 || (at > 0 && !/\s/.test(before[at - 1])) || /\s/.test(before.slice(at + 1))) return null;
    return { start: at, end: cursor, text: before.slice(at + 1) };
  }

  function chooseMention(candidate: MentionCandidate) {
    if (!mentionQuery) return;
    const token = `@${candidate.label}`;
    const nextDraft = `${draft.slice(0, mentionQuery.start)}${token}${draft.slice(mentionQuery.end)}`;
    const nextMention: MessageMention = {
      targetKind: candidate.targetKind,
      targetId: candidate.targetId,
      label: candidate.label,
      providerSnapshot: candidate.providerSnapshot,
      modelSnapshot: candidate.modelSnapshot,
      revision: candidate.revision,
      start: mentionQuery.start,
      end: mentionQuery.start + token.length,
    };
    onDraftChange(nextDraft);
    onMentionsChange([...reconcileMessageMentionsAfterEdit(draft, nextDraft, mentions), nextMention]
      .filter((mention, index, all) => all.findIndex(({ start }) => start === mention.start) === index)
      .sort((left, right) => left.start - right.start));
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const cursor = mentionQuery.start + token.length;
      textarea.current?.focus();
      textarea.current?.setSelectionRange(cursor, cursor);
    });
  }

  function updateStyle(update: Partial<ChatStyle>) {
    onStyleChange({ ...style, ...update });
  }

  function insertSmiley(shortcut: string) {
    const input = textarea.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    const nextDraft = `${draft.slice(0, start)}${shortcut}${draft.slice(end)}`;
    onDraftChange(nextDraft);
    onMentionsChange(reconcileMessageMentions(nextDraft, mentions));
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(start + shortcut.length, start + shortcut.length);
    });
  }

  function chooseColor(color: string) {
    updateStyle(colorPicker === "background" ? { backgroundColor: color } : { textColor: color });
    setColorPicker(null);
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <div className="format-toolbar" role="toolbar" aria-label="Message formatting">
        <select
          aria-label="Font family"
          value={style.fontFamily}
          onChange={(event) => updateStyle({ fontFamily: event.target.value as ChatStyle["fontFamily"] })}
        >
          {CHAT_FONT_FAMILIES.map((font) => <option value={font} key={font}>{font}</option>)}
        </select>
        <select
          className="font-size-select"
          aria-label="Outgoing font size"
          title="Font size sent with your messages"
          value={style.fontSize}
          onChange={(event) => updateStyle({ fontSize: Number(event.target.value) })}
        >
          {CHAT_FONT_SIZES.map((size) => <option value={size} key={size}>{size}</option>)}
        </select>
        <button type="button" className="format-bold" aria-label="Bold" aria-pressed={style.bold} onClick={() => updateStyle({ bold: !style.bold })}>B</button>
        <button type="button" className="format-italic" aria-label="Italic" aria-pressed={style.italic} onClick={() => updateStyle({ italic: !style.italic })}>I</button>
        <button type="button" className="format-underline" aria-label="Underline" aria-pressed={style.underline} onClick={() => updateStyle({ underline: !style.underline })}>U</button>
        <button
          type="button"
          className="color-well color-well--text"
          title="Text color"
          aria-label="Text color"
          aria-expanded={colorPicker === "text"}
          onClick={() => {
            setEmojiOpen(false);
            setColorPicker((current) => current === "text" ? null : "text");
          }}
        >
          <span aria-hidden="true">A</span>
          <i aria-hidden="true" style={{ backgroundColor: style.textColor }} />
        </button>
        <button
          type="button"
          className="color-well color-well--background"
          title="Message highlight color"
          aria-label="Message highlight color"
          aria-expanded={colorPicker === "background"}
          onClick={() => {
            setEmojiOpen(false);
            setColorPicker((current) => current === "background" ? null : "background");
          }}
        >
          <span aria-hidden="true">▧</span>
          <i aria-hidden="true" style={{ backgroundColor: style.backgroundColor }} />
        </button>
        <div className="emoji-control">
          <button type="button" aria-label="Classic emojis" aria-expanded={emojiOpen} onClick={() => {
            setColorPicker(null);
            setEmojiOpen((open) => !open);
          }}>☺</button>
        </div>
      </div>
      {colorPicker ? (
        <div className="aim-color-picker" aria-label={`${colorPicker === "text" ? "Text" : "Message highlight"} color palette`}>
          <strong>{colorPicker === "text" ? "Text color" : "Message highlight"}</strong>
          <span>Basic colors:</span>
          <div className="aim-color-grid">
            {AIM_5_BASIC_COLORS.map((color, index) => (
              <button
                type="button"
                className="aim-color-swatch"
                key={`${color}-${index}`}
                aria-label={`Select ${color}`}
                aria-pressed={(colorPicker === "text" ? style.textColor : style.backgroundColor) === color}
                style={{ backgroundColor: color }}
                onClick={() => chooseColor(color)}
              />
            ))}
          </div>
          <span>Custom colors:</span>
          <div className="aim-color-grid">
            {AIM_5_CUSTOM_COLORS.map((color, index) => (
              <button
                type="button"
                className="aim-color-swatch"
                key={`${color}-${index}`}
                aria-label={`Select ${color}`}
                aria-pressed={(colorPicker === "text" ? style.textColor : style.backgroundColor) === color}
                style={{ backgroundColor: color }}
                onClick={() => chooseColor(color)}
              />
            ))}
          </div>
        </div>
      ) : null}
      {emojiOpen ? (
        <div className="emoji-picker" aria-label="Classic AIM smiley picker">
          {AIM_SMILEYS.map((smiley) => (
            <button type="button" key={smiley.name} aria-label={`Insert ${smiley.name} ${smiley.shortcut}`} title={`${smiley.name} (${smiley.shortcut})`} onClick={() => insertSmiley(smiley.shortcut)}>
              <img src={smiley.src} alt="" aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        ref={textarea}
        value={draft}
        style={chatStyleProperties(style)}
        aria-autocomplete="list"
        aria-controls={matchingMentions.length ? "mention-suggestions" : undefined}
        aria-activedescendant={matchingMentions.length ? `mention-option-${activeMention}` : undefined}
        onChange={(event) => {
          const value = event.target.value;
          onDraftChange(value);
          onMentionsChange(reconcileMessageMentionsAfterEdit(draft, value, mentions));
          setMentionQuery(queryAt(value, event.target.selectionStart));
        }}
        onSelect={(event) => setMentionQuery(queryAt(event.currentTarget.value, event.currentTarget.selectionStart))}
        placeholder={sendDisabled ? "Connection lost — your draft is saved" : "Message everyone in this room..."}
        aria-label="Message"
        onKeyDown={(event) => {
          if (matchingMentions.length && event.key === "ArrowDown") {
            event.preventDefault();
            setActiveMention((current) => (current + 1) % matchingMentions.length);
            return;
          }
          if (matchingMentions.length && event.key === "ArrowUp") {
            event.preventDefault();
            setActiveMention((current) => (current - 1 + matchingMentions.length) % matchingMentions.length);
            return;
          }
          if (mentionQuery && event.key === "Escape") {
            event.preventDefault();
            setMentionQuery(null);
            return;
          }
          if (matchingMentions.length && (event.key === "Enter" || event.key === "Tab")) {
            event.preventDefault();
            chooseMention(matchingMentions[activeMention]);
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      {matchingMentions.length ? (
        <div id="mention-suggestions" className="mention-suggestions" role="listbox" aria-label="Mention a participant">
          {matchingMentions.map((candidate, index) => (
            <button
              type="button"
              role="option"
              id={`mention-option-${index}`}
              aria-selected={index === activeMention}
              key={`${candidate.targetKind}:${candidate.targetId}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseMention(candidate)}
            >
              <strong>@{candidate.label}</strong><span>{candidate.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      <button className="classic-button send-button" type="submit" disabled={sendDisabled || !draft.trim()}>Send</button>
    </form>
  );
}

interface RoomControlsProps {
  roomName: string;
  topic: string;
  conversationEnergy: ConversationEnergy;
  disabled: boolean;
  onRoomNameChange: (roomName: string) => void;
  onTopicChange: (topic: string) => void;
  onConversationEnergyChange: (energy: ConversationEnergy) => void;
}

export function RoomControls({
  roomName,
  topic,
  conversationEnergy,
  disabled,
  onRoomNameChange,
  onTopicChange,
  onConversationEnergyChange,
}: RoomControlsProps) {
  return (
    <aside className="controls-panel beveled-inset" aria-label="Room controls">
      <PanelTitle>Room Settings</PanelTitle>
      <label className="field-label" htmlFor="room-name">Room name</label>
      <input
        id="room-name"
        key={roomName}
        className="classic-input"
        type="text"
        maxLength={80}
        defaultValue={roomName}
        onBlur={(event) => {
          const nextRoomName = event.currentTarget.value.trim() || "The Agent Room";
          event.currentTarget.value = nextRoomName;
          onRoomNameChange(nextRoomName);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <p className="field-help">Shown in the room window and transcript header.</p>
      <label className="field-label" htmlFor="room-topic">Topic</label>
      <input
        id="room-topic"
        key={topic}
        className="classic-input"
        type="text"
        maxLength={160}
        defaultValue={topic}
        onBlur={(event) => {
          const nextTopic = event.currentTarget.value.trim() || "Open conversation";
          event.currentTarget.value = nextTopic;
          onTopicChange(nextTopic);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <p className="field-help">A starting point, not a boundary. Changing it starts fresh agent context.</p>
      <hr />
      <label className="field-label" htmlFor="conversation-energy">Conversation energy</label>
      <select
        id="conversation-energy"
        className="classic-input"
        value={conversationEnergy}
        disabled={disabled}
        onChange={(event) => onConversationEnergyChange(event.target.value as ConversationEnergy)}
      >
        {CONVERSATION_ENERGY_LEVELS.map((energy) => (
          <option value={energy} key={energy}>{CONVERSATION_ENERGY_POLICIES[energy].label}</option>
        ))}
      </select>
      <p className="field-help">{CONVERSATION_ENERGY_POLICIES[conversationEnergy].description}</p>
    </aside>
  );
}

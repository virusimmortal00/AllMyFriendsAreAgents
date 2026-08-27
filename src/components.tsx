import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from "react";
import {
  AIM_5_BASIC_COLORS,
  AIM_5_CUSTOM_COLORS,
  CHAT_FONT_FAMILIES,
  CHAT_FONT_SIZES,
  CHAT_FONT_STACKS,
  type ChatStyle,
} from "../shared/chat-style";
import { visibleAgentChatText, visibleAgentText } from "../shared/message-format";
import { AGENT_IDS, AGENT_PROFILES, agentScreenName, isAgentId, participantScreenName, type ActiveAgentId } from "../shared/participants";
import type { ImplementationCapability, ImplementationUnavailableReason } from "../shared/protocol";
import { AIM_SMILEYS, renderAimSmileys } from "./aim-smileys";
import { CONVERSATION_ENERGY_LEVELS, CONVERSATION_ENERGY_POLICIES, type ConversationEnergy } from "../shared/conversation-energy";
import type { AgentHealth, AgentId, HumanPresence, PublicPollProjection, RoomMessage } from "./types";
import { improvementReferences } from "../shared/workshop";
import type { WorkshopResponse } from "./types";
import { workshopLayout } from "./workshop-dialog";
import { reconcileMessageMentionsAfterEdit, type MentionCandidate, type MessageMention } from "../shared/mentions";
import { useDismissibleLayer, useModalOverlay } from "./overlay";
import { isTranscriptFollowing, preferredScrollBehavior, scrollTranscriptToEnd } from "./scroll";
import type { RoomAgentRoster } from "../shared/roster";
import { friendlyModelName, modelAuthorId, providerDisplayName } from "../shared/model-presentation";
import { ProviderMark } from "./provider-mark";
import { agentListGroupLabel, sortAgentListItems, type AgentListSort } from "./agent-list-sort";
import { HumanAvatar } from "./human-avatar";

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
  return <h2 className="panel-title" data-route-heading tabIndex={-1}>{children}</h2>;
}

export function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  busyLabel = "Working…",
  busy = false,
  error = "",
  returnFocusTo,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  error?: string;
  returnFocusTo: HTMLElement | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const requestCancel = () => { if (!busy) onCancel(); };
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(requestCancel, returnFocusTo);

  return (
    <div className="modal-backdrop confirmation-backdrop" onMouseDown={onBackdropMouseDown}>
      <section
        ref={dialogRef}
        className="agent-settings-window confirmation-window"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <header className="agent-settings-titlebar"><h2 id={titleId}>{title}</h2></header>
        <div className="confirmation-body" id={descriptionId}>{description}</div>
        {error ? <p className="confirmation-error" role="alert">{error}</p> : null}
        <footer className="agent-settings-actions confirmation-actions">
          <button type="button" className="classic-button" disabled={busy} onClick={requestCancel}>Cancel</button>
          <button type="button" className="classic-button confirmation-confirm" disabled={busy} onClick={onConfirm}>{busy ? busyLabel : confirmLabel}</button>
        </footer>
      </section>
    </div>
  );
}

export function RoomRoster({
  availability,
  agentHealth,
  activeAgents,
  humans,
  currentHumanId,
  agents = AGENT_IDS,
  roster,
  agentListSort = "room",
  onOpenRoomProperties,
  onManageRoster,
  onConfigureHumanAvatar,
}: {
  availability?: Partial<Record<ActiveAgentId, boolean>>;
  agentHealth?: Partial<Record<ActiveAgentId, AgentHealth>>;
  activeAgents?: ReadonlySet<AgentId>;
  humans: HumanPresence[];
  currentHumanId: string;
  agents?: readonly ActiveAgentId[];
  roster?: RoomAgentRoster;
  agentListSort?: AgentListSort;
  onOpenRoomProperties?: (trigger: HTMLButtonElement) => void;
  onManageRoster?: (trigger: HTMLElement, selectedAgentId?: ActiveAgentId) => void;
  onConfigureHumanAvatar?: (trigger: HTMLButtonElement) => void;
}) {
  const healthText = (health: AgentHealth) => health.status === "cooldown"
    ? `Cooling down${health.retryAt ? ` until ${new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(health.retryAt))}` : ""}`
    : "Unavailable";
  const presentAgents = sortAgentListItems(agents.filter((agent) => availability?.[agent] !== false).map((agent) => {
    const rosterEntry = roster?.entries.find((entry) => entry.agentId === agent);
    const profile = AGENT_PROFILES[agent];
    const alias = rosterEntry?.conversationalName || profile?.conversationalName || participantScreenName(agent);
    const providerId = rosterEntry?.providerId || profile?.provider;
    const modelId = rosterEntry?.modelId || profile?.modelId || "configured";
    return { agentId: agent, alias, providerId, modelId, authorId: modelAuthorId(providerId, modelId) };
  }), agentListSort);
  return (
    <aside className="presence-panel beveled-inset" aria-label="People in this room">
      <div className="presence-list" role="list">
        {presentAgents.map((item, index) => {
          const agent = item.agentId;
          const active = activeAgents?.has(agent) ?? false;
          const { alias, providerId, modelId, authorId } = item;
          const modelName = friendlyModelName(modelId);
          const routeName = providerDisplayName(providerId);
          const availableLabel = `${alias}: ${modelName} via ${routeName}`;
          const configurable = Boolean(onManageRoster);
          const groupLabel = agentListGroupLabel(item, agentListSort);
          const previousGroupLabel = index > 0 ? agentListGroupLabel(presentAgents[index - 1], agentListSort) : undefined;
          return (
            <Fragment key={agent}>
            {groupLabel && groupLabel !== previousGroupLabel ? <div className="presence-group-label" role="presentation">{groupLabel}</div> : null}
            <div
              className={`presence-row${active ? " presence-row--active" : ""}${configurable ? " presence-row--configurable" : ""}`}
              role={configurable ? "button" : "listitem"}
              tabIndex={configurable ? 0 : undefined}
              aria-label={configurable ? `Configure ${availableLabel}` : undefined}
              onDoubleClick={configurable ? (event) => {
                event.currentTarget.focus({ preventScroll: true });
                onManageRoster?.(event.currentTarget, agent);
              } : undefined}
              onKeyDown={configurable ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onManageRoster?.(event.currentTarget, agent);
              } : undefined}
            >
              <span
                className={`presence-status${agentHealth?.[agent] ? ` presence-status--${agentHealth[agent].status}` : ""}`}
                aria-label={agentHealth?.[agent] ? `${availableLabel}: ${agentHealth[agent].message}` : `${availableLabel}: available`}
                title={agentHealth?.[agent]?.message || "Available"}
              />
              <ProviderMark authorId={authorId} accessProviderId={providerId} compact />
              <span className="presence-identity">
                <strong className={`speaker speaker--${agent}`} title={alias}>{alias}</strong>
                <span className="presence-meta">
                  <small className="presence-model-label">{modelName}{providerId ? ` · via ${routeName}` : ""}</small>
                  {agentHealth?.[agent] ? <small className="presence-health" title={healthText(agentHealth[agent])}>{healthText(agentHealth[agent])}</small> : null}
                </span>
              </span>
              <span className="presence-agent-actions">
                {active ? (
                  <span className="agent-activity-indicator" role="status" aria-label={`${alias} is generating a response`} title="Generating a response">
                    <i /><i /><i />
                  </span>
                ) : null}
              </span>
            </div>
            </Fragment>
          );
        })}
        {humans.map((human) => (
          <div className="presence-row presence-row--human" role="listitem" key={human.id}>
            <span className="presence-status" aria-hidden="true" />
            <HumanAvatar name={human.name} avatarUrl={human.avatarUrl} compact />
            <strong className="speaker speaker--you presence-human-name">{human.name}{human.id === currentHumanId ? " (You)" : ""}</strong>
            {human.id === currentHumanId && onConfigureHumanAvatar ? <button type="button" className="agent-settings-button human-avatar-settings-button" aria-label="Edit your profile" title="Your profile" onClick={(event) => onConfigureHumanAvatar(event.currentTarget)}>📷</button> : <span className="presence-row-spacer" aria-hidden="true" />}
          </div>
        ))}
      </div>
      {onOpenRoomProperties || onManageRoster ? <footer className="presence-footer">
        {onOpenRoomProperties ? <button type="button" onClick={(event) => onOpenRoomProperties(event.currentTarget)}>Properties...</button> : null}
        {onManageRoster ? <button type="button" onClick={(event) => onManageRoster(event.currentTarget)}>Manage agents...</button> : null}
      </footer> : null}
    </aside>
  );
}

export function AgentSettingsDialog({
  agent,
  available,
  health,
  implementationCapability,
  onClose,
}: {
  agent: ActiveAgentId;
  available: boolean;
  health?: AgentHealth;
  implementationCapability?: ImplementationCapability;
  onClose: () => void;
}) {
  const connectionState = !available ? "offline" : health?.status || "online";
  const retryDescription = health?.retryAt
    ? ` Retry after ${new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(health.retryAt))}.`
    : "";
  const requestClose = onClose;
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(requestClose);
  const capability = implementationCapability || { eligible: false, available: false, unavailableReason: "participant-ineligible" as const };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={onBackdropMouseDown}
    >
      <section ref={dialogRef} className="agent-settings-window" role="dialog" aria-modal="true" aria-labelledby="agent-settings-title" tabIndex={-1} onKeyDown={onDialogKeyDown}>
        <header className="agent-settings-titlebar">
          <h2 id="agent-settings-title">Agent Settings</h2>
          <button type="button" aria-label="Close agent settings" onClick={requestClose}>×</button>
        </header>
        <div className="agent-settings-body">
          <strong className={`agent-settings-name speaker speaker--${agent}`}>{agentScreenName(agent)}</strong>
          <div className="agent-connection-status">
            <span className={`agent-connection-light agent-connection-light--${connectionState}`} aria-hidden="true" />
            {!available ? "CLI unavailable" : health ? `${health.message}${retryDescription}` : "Connected to the room"}
          </div>
          <fieldset>
            <legend>Implementation handoff</legend>
            <p className={capability.available ? "agent-settings-status" : "agent-settings-warning"} role="status">
              <strong>{capability.available ? "Available" : "Unavailable"}.</strong>{" "}
              {capability.available ? "A governed assignment is ready for a separate implementation worker." : implementationReason(capability.unavailableReason)}
            </p>
            <p>Room conversation and reviews always stay read-only. Source changes require an explicit governed handoff to a separate implementation worker.</p>
          </fieldset>
        </div>
        <footer className="agent-settings-actions">
          <button type="button" className="classic-button" onClick={requestClose}>Close</button>
        </footer>
      </section>
    </div>
  );
}

function implementationReason(reason: ImplementationUnavailableReason | undefined) {
  if (reason === "no-active-assignment") return "No active governed assignment is available.";
  if (reason === "assignment-owner-mismatch") return "The current assignment belongs to a different implementation worker.";
  if (reason === "governance-invalid") return "The assignment governance is no longer current.";
  if (reason === "confinement-unavailable") return "The isolated implementation workspace is unavailable.";
  return "This participant is not eligible for implementation handoff.";
}

const TIME_FORMATTER = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
const MESSAGE_URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const MESSAGE_MARKDOWN_LINK_START_PATTERN = /\[([^\]\r\n]+)\]\(/;

function formatTime(timestamp: string) {
  return TIME_FORMATTER.format(new Date(timestamp));
}

function splitUrlPunctuation(candidate: string) {
  let href = candidate;
  let trailing = "";
  const detachLast = () => {
    trailing = `${href.at(-1) || ""}${trailing}`;
    href = href.slice(0, -1);
  };

  while (/[.,!?;:]$/.test(href)) detachLast();
  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
    while (href.endsWith(closing) && href.split(closing).length > href.split(opening).length) detachLast();
  }
  return { href, trailing };
}

function safeMessageUrl(href: string) {
  try {
    const parsed = new URL(href);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function plainLinkedMessageText(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(MESSAGE_URL_PATTERN)) {
    const start = match.index;
    const candidate = match[0];
    const { href: label, trailing } = splitUrlPunctuation(candidate);
    const href = /^www\./i.test(label) ? `https://${label}` : label;
    if (!safeMessageUrl(href)) continue;

    if (start > offset) parts.push(<Fragment key={`${keyPrefix}-text-${offset}`}>{renderAimSmileys(text.slice(offset, start))}</Fragment>);
    parts.push(<a className="message-link" href={href} target="_blank" rel="noopener noreferrer" key={`${keyPrefix}-url-${start}`}>{label}</a>);
    if (trailing) parts.push(trailing);
    offset = start + candidate.length;
  }
  if (offset < text.length) parts.push(<Fragment key={`${keyPrefix}-text-${offset}`}>{renderAimSmileys(text.slice(offset))}</Fragment>);
  return parts;
}

function markdownDestinationEnd(text: string, start: number) {
  let nestedParentheses = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (/\s|[<>"']/.test(character)) return -1;
    if (character === "(") {
      nestedParentheses += 1;
    } else if (character === ")") {
      if (nestedParentheses === 0) return index;
      nestedParentheses -= 1;
    }
  }
  return -1;
}

function linkedMessageText(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let offset = 0;
  let searchOffset = 0;
  while (searchOffset < text.length) {
    const match = text.slice(searchOffset).match(MESSAGE_MARKDOWN_LINK_START_PATTERN);
    if (!match || match.index === undefined) break;
    const start = searchOffset + match.index;
    const label = match[1];
    const destinationStart = start + match[0].length;
    const destinationEnd = markdownDestinationEnd(text, destinationStart);
    if (destinationEnd < 0) {
      searchOffset = destinationStart;
      continue;
    }
    const href = text.slice(destinationStart, destinationEnd);
    if (!safeMessageUrl(href)) {
      searchOffset = destinationEnd + 1;
      continue;
    }

    if (start > offset) parts.push(...plainLinkedMessageText(text.slice(offset, start), `${keyPrefix}-plain-${offset}`));
    parts.push(<a className="message-link" href={href} target="_blank" rel="noopener noreferrer" key={`${keyPrefix}-markdown-${start}`}>{renderAimSmileys(label)}</a>);
    offset = destinationEnd + 1;
    searchOffset = offset;
  }
  if (offset < text.length) parts.push(...plainLinkedMessageText(text.slice(offset), `${keyPrefix}-plain-${offset}`));
  return parts;
}

function messageText(text: string, onOpenImprovement?: (id: string, trigger: HTMLButtonElement) => void) {
  const references = improvementReferences(text);
  if (!references.length) return linkedMessageText(text, "message");
  const parts: React.ReactNode[] = [];
  let offset = 0;
  references.forEach((reference) => {
    parts.push(...linkedMessageText(text.slice(offset, reference.start), `reference-${reference.start}`));
    parts.push(<button type="button" className="improvement-reference" key={`${reference.id}-${reference.start}`} aria-label={`Open ${reference.label}`} onClick={(event) => onOpenImprovement?.(reference.id, event.currentTarget)}>{reference.label}</button>);
    offset = reference.end;
  });
  parts.push(...linkedMessageText(text.slice(offset), `reference-tail-${offset}`));
  return parts;
}

function equalChatStyle(left: ChatStyle | undefined, right: ChatStyle | undefined) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.fontFamily === right.fontFamily
    && left.fontSize === right.fontSize
    && left.textColor === right.textColor
    && left.backgroundColor === right.backgroundColor
    && left.bold === right.bold
    && left.italic === right.italic
    && left.underline === right.underline;
}

const TranscriptMessage = memo(function TranscriptMessage({
  message,
  magnification,
  onOpenImprovement,
}: {
  message: RoomMessage;
  magnification: number;
  onOpenImprovement?: (id: string, trigger: HTMLButtonElement) => void;
}) {
  const visibleText = isAgentId(message.speaker)
    ? visibleAgentChatText(message.text)
    : visibleAgentText(message.text);
  return (
    <article className={`message message--${message.kind || "chat"}`}>
      <time>[{formatTime(message.timestamp)}]</time>
      <div>
        <strong className={`speaker speaker--${message.speaker}`}>{message.speakerName || participantScreenName(message.speaker)}:</strong>{" "}
        <span className="message__bubble" style={message.style ? chatStyleProperties(message.style, magnification) : undefined}>
          <span className="message__text">{messageText(visibleText, onOpenImprovement)}</span>
        </span>
      </div>
    </article>
  );
}, (previous, next) => previous.magnification === next.magnification
  && previous.onOpenImprovement === next.onOpenImprovement
  && previous.message.id === next.message.id
  && previous.message.kind === next.message.kind
  && previous.message.speaker === next.message.speaker
  && previous.message.speakerName === next.message.speakerName
  && previous.message.text === next.message.text
  && previous.message.timestamp === next.message.timestamp
  && equalChatStyle(previous.message.style, next.message.style));

export const Transcript = memo(function Transcript({
  messages,
  magnification,
  showTimestamps = true,
  transcriptRef,
  onOpenImprovement,
}: {
  messages: RoomMessage[];
  magnification: number;
  showTimestamps?: boolean;
  transcriptRef: RefObject<HTMLDivElement | null>;
  onOpenImprovement?: (id: string, trigger: HTMLButtonElement) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const resizeFrame = useRef<number | undefined>(undefined);
  const previousContent = useRef("");
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const lastMessage = messages.at(-1);
  const lastText = lastMessage?.text || "";
  const contentSignature = `${messages.length}:${lastMessage?.id || ""}:${lastText.length}:${lastText.slice(-64)}`;

  const followEnd = useCallback((behavior: ScrollBehavior = "auto") => {
    following.current = true;
    setHasNewMessages(false);
    scrollTranscriptToEnd(transcriptRef.current, behavior);
  }, [transcriptRef]);

  useLayoutEffect(() => {
    if (previousContent.current === contentSignature) return;
    previousContent.current = contentSignature;
    if (following.current) followEnd();
    else setHasNewMessages(true);
  }, [contentSignature, followEnd]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    const content = contentRef.current;
    if (!transcript || !content || typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(() => {
      if (!following.current || resizeFrame.current !== undefined) return;
      resizeFrame.current = requestAnimationFrame(() => {
        resizeFrame.current = undefined;
        if (following.current) scrollTranscriptToEnd(transcript, "auto");
      });
    });
    resizeObserver.observe(transcript);
    resizeObserver.observe(content);
    return () => {
      resizeObserver.disconnect();
      if (resizeFrame.current !== undefined) cancelAnimationFrame(resizeFrame.current);
    };
  }, [transcriptRef]);

  return (
    <div className="transcript-shell">
      <div
        ref={transcriptRef}
        className={`transcript beveled-inset${showTimestamps ? "" : " transcript--timestamps-hidden"}`}
        role="log"
        aria-live="polite"
        aria-label="Room transcript"
        style={{ "--transcript-magnification": magnification / 100 } as CSSProperties}
        onScroll={() => {
          const transcript = transcriptRef.current;
          if (!transcript) return;
          following.current = isTranscriptFollowing(transcript);
          if (following.current) setHasNewMessages(false);
        }}
      >
        <div ref={contentRef} className="transcript-content">
          {messages.map((message) => <TranscriptMessage key={message.id} message={message} magnification={magnification} onOpenImprovement={onOpenImprovement} />)}
        </div>
      </div>
      {hasNewMessages ? (
        <button type="button" className="new-messages-button" onClick={() => followEnd(preferredScrollBehavior())}>
          New messages ↓
        </button>
      ) : null}
    </div>
  );
});

export function PollCards({ polls, disabled = false, pending = null, error = "", onVote, onClose }: {
  polls: readonly PublicPollProjection[];
  disabled?: boolean;
  pending?: string | null;
  error?: string;
  onVote: (pollId: string, optionIndex: number) => void;
  onClose: (pollId: string, expectedRevision: number) => void;
}) {
  const open = polls.filter((poll) => poll.state === "OPEN");
  if (!open.length) return null;
  return <section className="poll-cards" aria-label="Room polls" aria-live="polite">
    {error ? <p role="alert" className="poll-card__error">{error}</p> : null}
    {open.map((poll) => <article className="poll-card" key={poll.pollId}>
      <header><h3>{poll.question}</h3><span className="poll-card__state">Open</span></header>
      <p>{poll.totalVotes} {poll.totalVotes === 1 ? "vote" : "votes"}</p>
      <ol>{poll.options.map((option, index) => <li key={`${poll.pollId}:${index}`}><button type="button" disabled={disabled||poll.ownVote!==null} aria-pressed={poll.ownVote===index} onClick={() => onVote(poll.pollId, index)} aria-label={`${poll.ownVote===index?"Recorded choice: ":"Vote for "}${option}`}>{option}{poll.ownVote===index?" — your choice":""}</button><span aria-label={`${poll.tallies[index] || 0} votes`}>{poll.tallies[index] || 0}</span></li>)}</ol>
      {poll.canClose?<button type="button" className="classic-button poll-card__close" disabled={disabled||pending===`close:${poll.pollId}`} onClick={()=>{if(window.confirm("End this poll now? Other participants will no longer be able to vote."))onClose(poll.pollId,poll.revision);}}>End poll</button>:null}
    </article>)}
  </section>;
}

export function WorkshopDialog({ data, loading, missing, error = "", connected = true, onRetry, onClose, returnFocusTo = null }: { data: WorkshopResponse | null; loading: boolean; missing: boolean; error?: string; connected?: boolean; onRetry?: () => void; onClose: () => void; returnFocusTo?: HTMLElement | null }) {
  const view = data?.improvement;
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(onClose, returnFocusTo);
  const [presentation, setPresentation] = useState(() => workshopLayout(typeof window === "undefined" ? 1024 : window.innerWidth));
  useEffect(() => {
    const updatePresentation = () => setPresentation(workshopLayout(window.innerWidth));
    window.addEventListener("resize", updatePresentation);
    return () => window.removeEventListener("resize", updatePresentation);
  }, []);
  return <div className="modal-backdrop" onMouseDown={onBackdropMouseDown}>
    <section ref={dialogRef} className="workshop-window" role="dialog" aria-modal="true" aria-labelledby="workshop-title" tabIndex={-1} onKeyDown={onDialogKeyDown} data-responsive-layout="workshop" data-presentation={presentation}>
      <header className="agent-settings-titlebar"><h2 id="workshop-title">Improvement workshop</h2><button type="button" aria-label="Close improvement workshop" onClick={onClose}>×</button></header>
      <div className="workshop-body" aria-live="polite">
        {loading ? <p role="status">Loading improvement…</p> : missing ? <p role="status">This improvement is unavailable or was deleted (verified not found).</p> : error || !view ? <div className="workshop-recovery" role="alert">
          <p><strong>Could not load this improvement.</strong> {error || "The room returned an incomplete response."}</p>
          {!connected ? <p>Retry is unavailable while the room is reconnecting.</p> : null}
          <button type="button" className="classic-button" disabled={!connected} onClick={onRetry}>Retry</button>
        </div> : <>
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

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(onClose);
  return <div className="modal-backdrop" onMouseDown={onBackdropMouseDown}>
    <section ref={dialogRef} className="help-window" role="dialog" aria-modal="true" aria-labelledby="help-title" tabIndex={-1} onKeyDown={onDialogKeyDown}>
      <header className="agent-settings-titlebar"><h2 id="help-title">Help</h2><button type="button" aria-label="Close help" onClick={onClose}>×</button></header>
      <div className="help-body">
        <h3>Getting around</h3>
        <p>Menus close when you choose an action, click elsewhere, or press Escape. Panels and dialogs also have a visible close button.</p>
        <h3>Reading the room</h3>
        <p>Use the View menu to show or hide timestamps and change the transcript size on this device.</p>
        <h3>Project work</h3>
        <p>Use the gear beside an agent to manage project permissions. File changes require an authorized assignment worktree; reviews always remain read-only.</p>
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
  onBlur?: () => void;
}

export function ChatComposer({ draft, mentions = [], mentionCandidates = [], style, sendDisabled = false, onDraftChange, onMentionsChange = () => undefined, onStyleChange, onSubmit, onBlur }: ChatComposerProps) {
  const [formatPopover, setFormatPopover] = useState<"emoji" | "text" | "background" | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mentionSuggestions = useRef<HTMLDivElement>(null);
  const formatPopoverElement = useRef<HTMLDivElement>(null);
  const [formatPopoverPosition, setFormatPopoverPosition] = useState<{ left: number; top: number } | null>(null);
  const { layerRef: formatLayer, triggerRef: formatTrigger } = useDismissibleLayer(Boolean(formatPopover), () => setFormatPopover(null));
  const pendingEditRange = useRef<{ start: number; end: number } | null>(null);
  const [mentionQuery, setMentionQuery] = useState<{ start: number; end: number; text: string } | null>(null);
  const [activeMention, setActiveMention] = useState(0);
  const matchingMentions = mentionQuery
    ? mentionCandidates.filter((candidate) => `${candidate.label} ${candidate.description}`.toLowerCase().includes(mentionQuery.text.toLowerCase())).slice(0, 8)
    : [];

  useEffect(() => setActiveMention(0), [mentionQuery?.text]);

  useLayoutEffect(() => {
    if (!formatPopover) {
      setFormatPopoverPosition(null);
      return;
    }

    function positionPopover() {
      const trigger = formatTrigger.current;
      const popover = formatPopoverElement.current;
      if (!trigger || !popover) return;

      const triggerBounds = trigger.getBoundingClientRect();
      const popoverBounds = popover.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const margin = 8;
      const gap = 5;
      const minLeft = viewportLeft + margin;
      const maxLeft = viewportLeft + viewportWidth - popoverBounds.width - margin;
      const centeredLeft = triggerBounds.left + triggerBounds.width / 2 - popoverBounds.width / 2;
      const above = triggerBounds.top - popoverBounds.height - gap;
      const below = triggerBounds.bottom + gap;
      const maxTop = viewportTop + viewportHeight - popoverBounds.height - margin;

      setFormatPopoverPosition({
        left: Math.max(minLeft, Math.min(centeredLeft, maxLeft)),
        top: above >= viewportTop + margin ? above : Math.max(viewportTop + margin, Math.min(below, maxTop)),
      });
    }

    positionPopover();
    window.addEventListener("resize", positionPopover);
    window.visualViewport?.addEventListener("resize", positionPopover);
    window.visualViewport?.addEventListener("scroll", positionPopover);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.visualViewport?.removeEventListener("resize", positionPopover);
      window.visualViewport?.removeEventListener("scroll", positionPopover);
    };
  }, [formatPopover, formatTrigger]);

  function queryAt(value: string, cursor: number) {
    const before = value.slice(0, cursor);
    const at = before.lastIndexOf("@");
    if (at < 0 || (at > 0 && !/\s/.test(before[at - 1])) || /\s/.test(before.slice(at + 1))) return null;
    return { start: at, end: cursor, text: before.slice(at + 1) };
  }

  function chooseMention(candidate: MentionCandidate) {
    if (!mentionQuery) return;
    const token = `@${candidate.label}`;
    const following = draft.slice(mentionQuery.end);
    const trailingSpace = following && /^\s/.test(following) ? "" : " ";
    const nextDraft = `${draft.slice(0, mentionQuery.start)}${token}${trailingSpace}${following}`;
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
    onMentionsChange([...reconcileMessageMentionsAfterEdit(draft, nextDraft, mentions, { start: mentionQuery.start, end: mentionQuery.end }), nextMention]
      .filter((mention, index, all) => all.findIndex(({ start }) => start === mention.start) === index)
      .sort((left, right) => left.start - right.start));
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const cursor = mentionQuery.start + token.length + trailingSpace.length;
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
    onMentionsChange(reconcileMessageMentionsAfterEdit(draft, nextDraft, mentions, { start, end }));
    setFormatPopover(null);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(start + shortcut.length, start + shortcut.length);
    });
  }

  function chooseColor(color: string) {
    updateStyle(formatPopover === "background" ? { backgroundColor: color } : { textColor: color });
    setFormatPopover(null);
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <div className="format-popover-layer" ref={formatLayer}>
      <div className="format-toolbar" role="toolbar" aria-label="Message formatting">
        <select
          aria-label="Font family"
          value={style.fontFamily}
          onChange={(event) => { setFormatPopover(null); updateStyle({ fontFamily: event.target.value as ChatStyle["fontFamily"] }); }}
        >
          {CHAT_FONT_FAMILIES.map((font) => <option value={font} key={font}>{font}</option>)}
        </select>
        <select
          className="font-size-select"
          aria-label="Outgoing font size"
          title="Font size sent with your messages"
          value={style.fontSize}
          onChange={(event) => { setFormatPopover(null); updateStyle({ fontSize: Number(event.target.value) }); }}
        >
          {CHAT_FONT_SIZES.map((size) => <option value={size} key={size}>{size}</option>)}
        </select>
        <button type="button" className="format-bold" aria-label="Bold" aria-pressed={style.bold} onClick={() => { setFormatPopover(null); updateStyle({ bold: !style.bold }); }}>B</button>
        <button type="button" className="format-italic" aria-label="Italic" aria-pressed={style.italic} onClick={() => { setFormatPopover(null); updateStyle({ italic: !style.italic }); }}>I</button>
        <button type="button" className="format-underline" aria-label="Underline" aria-pressed={style.underline} onClick={() => { setFormatPopover(null); updateStyle({ underline: !style.underline }); }}>U</button>
        <button
          ref={formatPopover === "text" ? formatTrigger : undefined}
          type="button"
          className="color-well color-well--text"
          title="Text color"
          aria-label="Text color"
          aria-haspopup="dialog"
          aria-expanded={formatPopover === "text"}
          onClick={() => setFormatPopover((current) => current === "text" ? null : "text")}
        >
          <span aria-hidden="true">A</span>
          <i aria-hidden="true" style={{ backgroundColor: style.textColor }} />
        </button>
        <button
          ref={formatPopover === "background" ? formatTrigger : undefined}
          type="button"
          className="color-well color-well--background"
          title="Message highlight color"
          aria-label="Message highlight color"
          aria-haspopup="dialog"
          aria-expanded={formatPopover === "background"}
          onClick={() => setFormatPopover((current) => current === "background" ? null : "background")}
        >
          <span aria-hidden="true">▧</span>
          <i aria-hidden="true" style={{ backgroundColor: style.backgroundColor }} />
        </button>
        <div className="emoji-control">
          <button ref={formatPopover === "emoji" ? formatTrigger : undefined} type="button" aria-label="Classic emojis" aria-haspopup="dialog" aria-expanded={formatPopover === "emoji"} onClick={() => setFormatPopover((current) => current === "emoji" ? null : "emoji")}>☺</button>
        </div>
      </div>
      {formatPopover === "text" || formatPopover === "background" ? (
        <div ref={formatPopoverElement} className="aim-color-picker" role="dialog" aria-label={`${formatPopover === "text" ? "Text" : "Message highlight"} color palette`} style={formatPopoverPosition ?? { visibility: "hidden" }}>
          <strong>{formatPopover === "text" ? "Text color" : "Message highlight"}</strong>
          <span>Basic colors:</span>
          <div className="aim-color-grid">
            {AIM_5_BASIC_COLORS.map((color, index) => (
              <button
                type="button"
                className="aim-color-swatch"
                key={`${color}-${index}`}
                aria-label={`Select ${color}`}
                aria-pressed={(formatPopover === "text" ? style.textColor : style.backgroundColor) === color}
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
                aria-pressed={(formatPopover === "text" ? style.textColor : style.backgroundColor) === color}
                style={{ backgroundColor: color }}
                onClick={() => chooseColor(color)}
              />
            ))}
          </div>
        </div>
      ) : null}
      {formatPopover === "emoji" ? (
        <div ref={formatPopoverElement} className="emoji-picker" role="dialog" aria-label="Classic AIM smiley picker" style={formatPopoverPosition ?? { visibility: "hidden" }}>
          {AIM_SMILEYS.map((smiley) => (
            <button type="button" key={smiley.name} aria-label={`Insert ${smiley.name} ${smiley.shortcut}`} title={`${smiley.name} (${smiley.shortcut})`} onClick={() => insertSmiley(smiley.shortcut)}>
              <img src={smiley.src} alt="" aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
      </div>
      <textarea
        ref={textarea}
        value={draft}
        style={chatStyleProperties(style)}
        aria-autocomplete="list"
        aria-controls={matchingMentions.length ? "mention-suggestions" : undefined}
        aria-activedescendant={matchingMentions.length ? `mention-option-${activeMention}` : undefined}
        onPasteCapture={(event) => {
          pendingEditRange.current = {
            start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd,
          };
        }}
        onCutCapture={(event) => {
          pendingEditRange.current = {
            start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd,
          };
        }}
        onBeforeInput={(event) => {
          pendingEditRange.current = {
            start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd,
          };
        }}
        onChange={(event) => {
          const value = event.target.value;
          onDraftChange(value);
          onMentionsChange(reconcileMessageMentionsAfterEdit(draft, value, mentions, pendingEditRange.current ?? undefined));
          pendingEditRange.current = null;
          setMentionQuery(queryAt(value, event.target.selectionStart));
        }}
        onSelect={(event) => setMentionQuery(queryAt(event.currentTarget.value, event.currentTarget.selectionStart))}
        onBlur={(event) => {
          onBlur?.();
          if (!mentionSuggestions.current?.contains(event.relatedTarget as Node | null)) setMentionQuery(null);
        }}
        placeholder={sendDisabled ? "Connection lost — your draft is saved" : undefined}
        aria-label="Message"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
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
        <div ref={mentionSuggestions} id="mention-suggestions" className="mention-suggestions" role="listbox" aria-label="Mention a participant">
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
              <i className={`mention-provider-mark mention-provider-mark--${candidate.targetKind}`} aria-hidden="true">{candidate.targetKind === "agent" ? "◆" : "●"}</i><strong title={`@${candidate.label}${candidate.description ? ` — ${candidate.description}` : ""}`}>@{candidate.label}</strong><span title={candidate.description}>{candidate.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      <button className="classic-button send-button" type="submit" disabled={sendDisabled || !draft.trim()}>Send</button>
    </form>
  );
}

export interface RoomSettingsInput {
  roomName: string;
  topic: string;
  conversationEnergy: ConversationEnergy;
}

interface RoomControlsProps extends RoomSettingsInput {
  disabled: boolean;
  onSave: (settings: RoomSettingsInput) => void | Promise<void>;
  onCancel?: () => void;
  onSaved?: () => void;
  showTitle?: boolean;
  propertySheet?: boolean;
}

export function RoomControls({
  roomName,
  topic,
  conversationEnergy,
  disabled,
  onSave,
  onCancel,
  onSaved,
  showTitle = true,
  propertySheet = false,
}: RoomControlsProps) {
  const [draft, setDraft] = useState<RoomSettingsInput>({ roomName, topic, conversationEnergy });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const current = { roomName, topic, conversationEnergy };
  const normalized = { ...draft, roomName: draft.roomName.trim(), topic: draft.topic.trim() };
  const valid = Boolean(normalized.roomName && normalized.topic);
  const dirty = draft.roomName !== roomName || draft.topic !== topic || draft.conversationEnergy !== conversationEnergy;
  const locked = disabled || saving;

  useEffect(() => {
    setDraft(current);
    setSaveError("");
  }, [roomName, topic, conversationEnergy]);

  function cancel() {
    setDraft(current);
    setSaveError("");
    setSaved(false);
    onCancel?.();
  }

  async function save(closeAfter: boolean) {
    setSaved(false);
    if (!valid || locked) return;
    if (!dirty) {
      if (closeAfter) onSaved?.();
      return;
    }
    setSaveError("");
    setSaving(true);
    try {
      await onSave(normalized);
      setDraft(normalized);
      setSaved(true);
      if (closeAfter) onSaved?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await save(true);
  }

  return (
    <aside className="controls-panel beveled-inset" aria-label="Room controls">
      {showTitle ? <PanelTitle>Room Settings</PanelTitle> : null}
      <form className="room-settings-form" onSubmit={(event) => void submit(event)}>
      <label className="field-label" htmlFor="room-name">Room name</label>
      <input
        id="room-name"
        className="classic-input"
        data-dialog-initial-focus={propertySheet ? "" : undefined}
        type="text"
        required
        maxLength={80}
        disabled={locked}
        value={draft.roomName}
        aria-invalid={!normalized.roomName}
        onChange={(event) => { setSaved(false); setDraft((value) => ({ ...value, roomName: event.target.value })); }}
      />
      <p className="field-help">Shown in the room window title bar.</p>
      <label className="field-label" htmlFor="room-topic">Topic</label>
      <input
        id="room-topic"
        className="classic-input"
        type="text"
        required
        maxLength={160}
        disabled={locked}
        value={draft.topic}
        aria-invalid={!normalized.topic}
        onChange={(event) => { setSaved(false); setDraft((value) => ({ ...value, topic: event.target.value })); }}
      />
      <p className="field-help">A starting point, not a boundary. Changing it starts fresh agent context.</p>
      <hr />
      <label className="field-label" htmlFor="conversation-energy">Conversation energy</label>
      <select
        id="conversation-energy"
        className="classic-input"
        value={draft.conversationEnergy}
        disabled={locked}
        onChange={(event) => { setSaved(false); setDraft((value) => ({ ...value, conversationEnergy: event.target.value as ConversationEnergy })); }}
      >
        {CONVERSATION_ENERGY_LEVELS.map((energy) => (
          <option value={energy} key={energy}>{CONVERSATION_ENERGY_POLICIES[energy].label}</option>
        ))}
      </select>
      <p className="field-help">{CONVERSATION_ENERGY_POLICIES[draft.conversationEnergy].description}</p>
      {!valid ? <p className="room-settings-error" role="alert">Room name and topic cannot be blank.</p> : null}
      {saveError ? <p className="room-settings-error" role="alert">Could not save room settings. {saveError}</p> : null}
      {saving ? <p className="room-settings-status" role="status">Saving room settings…</p> : saved ? <p className="room-settings-status" role="status">Room settings saved.</p> : null}
      <div className="room-settings-actions">
        {propertySheet ? <>
          <button type="submit" className="classic-button" data-default-button disabled={!valid || locked}>{saving ? "Saving…" : "OK"}</button>
          <button type="button" className="classic-button" disabled={saving} onClick={cancel}>Cancel</button>
          <button type="button" className="classic-button" disabled={!dirty || !valid || locked} onClick={() => void save(false)}>Apply</button>
        </> : <>
          <button type="button" className="classic-button" disabled={!dirty || saving} onClick={cancel}>Cancel</button>
          <button type="submit" className="classic-button" disabled={!dirty || !valid || locked}>{saving ? "Saving…" : "Save changes"}</button>
        </>}
      </div>
      </form>
    </aside>
  );
}

export function RoomSettingsDialog({
  returnFocusTo,
  onClose,
  ...controls
}: RoomControlsProps & { returnFocusTo: HTMLElement | null; onClose: () => void }) {
  const titleId = useId();
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(onClose, returnFocusTo);

  return (
    <div className="modal-backdrop room-settings-backdrop" onMouseDown={onBackdropMouseDown}>
      <section ref={dialogRef} className="agent-settings-window room-settings-window" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onDialogKeyDown}>
        <header className="agent-settings-titlebar">
          <h2 id={titleId}>Room Properties</h2>
          <button type="button" aria-label="Close Room Properties" onClick={onClose}>×</button>
        </header>
        <RoomControls {...controls} showTitle={false} propertySheet onCancel={onClose} onSaved={onClose} />
      </section>
    </div>
  );
}

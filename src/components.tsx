import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from "react";
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
import { workshopLayout } from "./workshop-dialog";
import { reconcileMessageMentionsAfterEdit, type MentionCandidate, type MessageMention } from "../shared/mentions";
import { useDismissibleLayer, useModalOverlay } from "./overlay";
import { isTranscriptFollowing, preferredScrollBehavior, scrollTranscriptToEnd } from "./scroll";

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
  onConfigureAgent,
  agents = AGENT_IDS,
  onOpenRoomProperties,
  onManageRoster,
}: {
  availability?: Partial<Record<ActiveAgentId, boolean>>;
  agentHealth?: Partial<Record<ActiveAgentId, AgentHealth>>;
  activeAgents?: ReadonlySet<AgentId>;
  humans: HumanPresence[];
  currentHumanId: string;
  onConfigureAgent: (agent: ActiveAgentId) => void;
  agents?: readonly ActiveAgentId[];
  onOpenRoomProperties?: (trigger: HTMLButtonElement) => void;
  onManageRoster?: (trigger: HTMLButtonElement) => void;
}) {
  const healthText = (health: AgentHealth) => health.status === "cooldown"
    ? `Cooling down${health.retryAt ? ` until ${new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(health.retryAt))}` : ""}`
    : "Unavailable";
  const presentAgents = agents.filter((agent) => availability?.[agent] !== false);
  return (
    <aside className="presence-panel beveled-inset" aria-label="People in this room">
      <div className="presence-list" role="list">
        {presentAgents.map((agent) => {
          const active = activeAgents?.has(agent) ?? false;
          return (
            <div className={`presence-row${active ? " presence-row--active" : ""}`} role="listitem" key={agent}>
              <span
                className={`presence-status${agentHealth?.[agent] ? ` presence-status--${agentHealth[agent].status}` : ""}`}
                aria-label={agentHealth?.[agent] ? `${agentScreenName(agent)}: ${agentHealth[agent].message}` : `${agentScreenName(agent)}: available`}
                title={agentHealth?.[agent]?.message || "Available"}
              />
              <span className="presence-identity">
                <strong className={`speaker speaker--${agent}`}>{participantScreenName(agent)}</strong>
                {active
                  ? <small className="presence-activity-label">Generating a response…</small>
                  : agentHealth?.[agent] ? <small className="presence-health">{healthText(agentHealth[agent])}</small> : null}
              </span>
              <span className="presence-agent-actions">
                {active ? (
                  <span className="agent-activity-indicator" role="status" aria-label={`${agentScreenName(agent)} is generating a response`} title="Generating a response">
                    <i /><i /><i />
                  </span>
                ) : null}
                <button
                  type="button"
                  className="agent-settings-button"
                  aria-label={`Configure ${agentScreenName(agent)}`}
                  title={`Settings for ${agentScreenName(agent)}`}
                  onClick={() => onConfigureAgent(agent)}
                >⚙</button>
              </span>
            </div>
          );
        })}
        {humans.map((human) => (
          <div className="presence-row" role="listitem" key={human.id}>
            <span className="presence-status" aria-hidden="true" />
            <strong className="speaker speaker--you">{human.name}{human.id === currentHumanId ? " (You)" : ""}</strong>
            <span className="presence-row-spacer" aria-hidden="true" />
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
  onWritableChange: (agent: WritableAgent) => void | Promise<void>;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [confirmGrant, setConfirmGrant] = useState(false);
  const permissionTrigger = useRef<HTMLInputElement>(null);
  const permissionSubmitting = useRef(false);
  const canEdit = writableAgent === agent;
  const supportsProjectWrites = agentSupportsProjectWrites(agent);
  const replacingAgent = writableAgent !== "nobody" && writableAgent !== agent
    ? agentScreenName(writableAgent)
    : "";
  const connectionState = !available ? "offline" : health?.status || "online";
  const retryDescription = health?.retryAt
    ? ` Retry after ${new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(health.retryAt))}.`
    : "";
  const requestClose = () => { if (!saving) onClose(); };
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(requestClose);

  async function changePermission(next: WritableAgent) {
    if (permissionSubmitting.current) return false;
    permissionSubmitting.current = true;
    setSaveError("");
    setSaving(true);
    try {
      await onWritableChange(next);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      permissionSubmitting.current = false;
      setSaving(false);
    }
  }

  async function confirmPermissionGrant() {
    if (permissionSubmitting.current) return;
    if (await changePermission(agent)) setConfirmGrant(false);
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={onBackdropMouseDown}
    >
      <section ref={dialogRef} className="agent-settings-window" role="dialog" aria-modal="true" aria-labelledby="agent-settings-title" tabIndex={-1} onKeyDown={onDialogKeyDown}>
        <header className="agent-settings-titlebar">
          <h2 id="agent-settings-title">Agent Settings</h2>
          <button type="button" aria-label="Close agent settings" disabled={saving} onClick={requestClose}>×</button>
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
                ref={permissionTrigger}
                type="checkbox"
                checked={canEdit}
                disabled={disabled || saving || !supportsProjectWrites}
                onChange={(event) => {
                  if (event.target.checked) {
                    setSaveError("");
                    setConfirmGrant(true);
                  } else void changePermission("nobody");
                }}
              />
              Allow this agent to edit project files
            </label>
            <p>{supportsProjectWrites
              ? "Applies only when you explicitly ask this agent to do project work. Reviews always stay read-only."
              : "This provider does not support project write access."}</p>
            {replacingAgent ? <p className="agent-settings-warning">Enabling this will remove edit access from {replacingAgent}.</p> : null}
            {disabled ? <p className="agent-settings-warning">Project permissions can be changed after the current agent turn finishes.</p> : null}
            {saving ? <p className="agent-settings-status" role="status">Saving project permission…</p> : null}
            {saveError ? <p className="agent-settings-error" role="alert">Could not save this permission. {saveError}</p> : null}
          </fieldset>
        </div>
        <footer className="agent-settings-actions">
          <button type="button" className="classic-button" disabled={saving} onClick={requestClose}>Close</button>
        </footer>
      </section>
      {confirmGrant ? <ConfirmationDialog
        title={replacingAgent ? "Transfer project write access?" : "Grant project write access?"}
        description={replacingAgent
          ? <p>This transfers project write access from <strong>{replacingAgent}</strong> to <strong>{agentScreenName(agent)}</strong>. Only one agent can hold write access.</p>
          : <p>This grants <strong>{agentScreenName(agent)}</strong> permission to edit project files when explicitly asked.</p>}
        confirmLabel={replacingAgent ? "Transfer write access" : "Grant write access"}
        busyLabel="Saving permission…"
        busy={saving}
        error={saveError ? `Could not save this permission. ${saveError}` : ""}
        returnFocusTo={permissionTrigger.current}
        onConfirm={() => void confirmPermissionGrant()}
        onCancel={() => setConfirmGrant(false)}
      /> : null}
    </div>
  );
}

const TIME_FORMATTER = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });

function formatTime(timestamp: string) {
  return TIME_FORMATTER.format(new Date(timestamp));
}

function messageText(text: string, onOpenImprovement?: (id: string, trigger: HTMLButtonElement) => void) {
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
        <strong className={`speaker speaker--${message.speaker}`}>{message.speaker === "you" && message.speakerName ? message.speakerName : participantScreenName(message.speaker)}:</strong>{" "}
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
    onMentionsChange([...reconcileMessageMentionsAfterEdit(draft, nextDraft, mentions, { start: mentionQuery.start, end: mentionQuery.end }), nextMention]
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
              <strong>@{candidate.label}</strong><span>{candidate.description}</span>
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
      <p className="field-help">Shown in the room window and transcript header.</p>
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

export function PeopleDialog({
  returnFocusTo,
  onClose,
  ...roster
}: React.ComponentProps<typeof RoomRoster> & { returnFocusTo: HTMLElement | null; onClose: () => void }) {
  const titleId = useId();
  const { dialogRef, onDialogKeyDown, onBackdropMouseDown } = useModalOverlay(onClose, returnFocusTo);

  return (
    <div className="modal-backdrop people-backdrop" onMouseDown={onBackdropMouseDown}>
      <section ref={dialogRef} className="agent-settings-window people-window" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onDialogKeyDown}>
        <header className="agent-settings-titlebar">
          <h2 id={titleId}>People in this room</h2>
          <button type="button" aria-label="Close people" onClick={onClose}>×</button>
        </header>
        <RoomRoster {...roster} />
        <footer className="agent-settings-actions">
          <button type="button" className="classic-button" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  );
}

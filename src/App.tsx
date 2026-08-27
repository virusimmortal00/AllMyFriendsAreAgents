import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { ApiRequestError, checkReady, joinRoom, loadImprovement, loadPolls, loadRoom, loadWorkshop, runAction, sendMessage, updateMyProfile, updateMyStyle, updateSettings, voteOnPoll } from "./api";
import { HelpDialog, PollCards, RoomRoster, RoomSettingsDialog, Transcript, WorkshopDialog, type RoomSettingsInput } from "./components";
import { ComposerBoundary, type ComposerBoundaryHandle, type ComposerSubmission } from "./composer";
import { preferredScrollBehavior, scrollTranscriptToEnd } from "./scroll";
import { appendOptimisticHumanMessage, discardOptimisticMessage } from "./optimistic-message";
import { adjacentTranscriptMagnification, loadTranscriptMagnification, loadTranscriptTimestamps, saveTranscriptMagnification, saveTranscriptTimestamps } from "./transcript-view";
import { loadDraftSnapshot, loadPendingSend, saveDraftSnapshot, savePendingSend, type PendingSend } from "./client-persistence";
import { reconnectDelayMs, restoreScrollDistance, scrollDistanceFromBottom } from "./reconnect";
import { nextWorkshopId } from "./workshop-dialog";
import { DEFAULT_PARTICIPANT_STYLES, sanitizeChatStyle, type ChatStyle } from "../shared/chat-style";
import { agentScreenName, type ActiveAgentId } from "../shared/participants";
import { ROOM_PROTOCOL_VERSION } from "../shared/protocol";
import type { AgentId, HumanPresence, PublicPollProjection, RoomState, WorkshopResponse } from "./types";
import { Improvements, improvementsRoute as readImprovementsRoute, resolveImprovementsAlias, type ImprovementsRoute } from "./improvements";
import { roomMentionCandidates } from "../shared/mentions";
import { reconcileRoomEvent } from "./room-reconciliation";
import type { RoomProtocolPosition } from "../shared/protocol";
import { Tasks } from "./tasks";
import { Continuations } from "./continuations";
import { Investigations } from "./investigations";
import { Contributions } from "./contributions";
import { RosterManagerDialog } from "./roster-manager";
import { defaultRoomAgentRoster, enabledRoomAgentIds, normalizeRoomAgentRoster } from "../shared/roster";
import { ClassicMenuBar, type ClassicMenuDefinition } from "./classic-menu";
import { loadAgentListSort, saveAgentListSort, type AgentListSort } from "./agent-list-sort";
import { HumanProfileDialog } from "./human-avatar";
import { validHumanAvatarDataUrl } from "../shared/human-avatar";
import { DEFAULT_CONVERSATION_ENERGY } from "../shared/conversation-energy";
import { RoomConfigurationDialog } from "./room-configuration-dialog";
import { Diagnostics } from "./diagnostics";

const EMPTY_ROOM: RoomState = {
  messages: [],
  settings: {
    roomName: "The Agent Room",
    topic: "Open conversation",
    conversationEnergy: DEFAULT_CONVERSATION_ENERGY,
    participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
  },
  status: "idle",
  roster: defaultRoomAgentRoster(),
};
const MINIMUM_LOADING_MS = 450;
const HUMAN_PROFILE_KEY = "all-my-friends-are-agents-human";
const ROOM_EVENT_STALE_MS = 9_000;
type RoomAction = "ask" | "review" | "roundtable" | "continue";
type ActionFailure = { action: RoomAction; target: AgentId | "all"; attempt: number; message: string; retrySafe: boolean };

function roomActionLabel(action: RoomAction, target: AgentId | "all") {
  const subject = target === "all" ? "all agents" : agentScreenName(target);
  if (action === "continue") return "Continue discussion";
  if (action === "roundtable") return "Start roundtable";
  if (action === "review") return `Review with ${subject}`;
  return `Ask ${subject}`;
}

function loadHumanProfile(): HumanPresence | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(HUMAN_PROFILE_KEY) || "null") as Partial<HumanPresence> | null;
    if (!value?.id || !value.name) return null;
    return {
      id: value.id,
      name: value.name,
      style: sanitizeChatStyle(value.style, DEFAULT_PARTICIPANT_STYLES.you),
      ...(validHumanAvatarDataUrl(value.avatarUrl) ? { avatarUrl: value.avatarUrl } : {}),
    };
  } catch {
    return null;
  }
}

function saveHumanProfile(human: HumanPresence | null) {
  if (typeof window === "undefined") return;
  if (human) window.localStorage.setItem(HUMAN_PROFILE_KEY, JSON.stringify(human));
  else window.localStorage.removeItem(HUMAN_PROFILE_KEY);
}

export function LoadingScreen({ error = "", joining = false, retrying = false, onRetry, onCancel }: { error?: string; joining?: boolean; retrying?: boolean; onRetry?: () => void; onCancel?: () => void }) {
  return (
    <main className="desktop">
      <section className="loading-window" aria-label="AllMyFriendsAreAgents loading">
        <header className="window-titlebar">
          <span className="app-icon" aria-hidden="true">AW</span>
          <h1>AllMyFriendsAreAgents</h1>
        </header>
        <div className="loading-dialog" role="status" aria-live="polite">
          <span className="retro-spinner" aria-hidden="true" />
          <strong>Entering The Agent Room...</strong>
          <span>{error || "Loading the latest conversation"}</span>
          {joining && error ? <div className="loading-dialog__actions">
            <button type="button" className="classic-button" disabled={retrying} onClick={onRetry}>{retrying ? "Retrying…" : "Retry now"}</button>
            <button type="button" className="classic-button" disabled={retrying} onClick={onCancel}>Use a different name</button>
          </div> : null}
        </div>
      </section>
    </main>
  );
}

export function NameEntry({ error = "", onJoin }: { error?: string; onJoin: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <main className="desktop">
      <section className="loading-window" aria-label="Join AllMyFriendsAreAgents">
        <header className="window-titlebar">
          <span className="app-icon" aria-hidden="true">AW</span>
          <h1>AllMyFriendsAreAgents</h1>
        </header>
        <form className="name-entry" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onJoin(name.trim()); }}>
          <strong>Welcome to The Agent Room</strong>
          <label htmlFor="human-name">What should everyone call you?</label>
          <input id="human-name" className="classic-input" autoFocus maxLength={32} value={name} onChange={(event) => setName(event.target.value)} />
          {error ? <span className="name-entry__error" role="alert">{error}</span> : <span>Names are local to this room; no account is required.</span>}
          <button className="classic-button" type="submit" disabled={!name.trim()}>Enter room</button>
        </form>
      </section>
    </main>
  );
}

export default function App() {
  const [room, setRoomState] = useState<RoomState>(EMPTY_ROOM);
  const roomRef = useRef(room);
  const setRoom = useCallback((action: SetStateAction<RoomState>) => {
    const next = typeof action === "function" ? action(roomRef.current) : action;
    roomRef.current = next;
    setRoomState(next);
  }, []);
  const [savedHuman, setSavedHuman] = useState(loadHumanProfile);
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(() => typeof window === "undefined" ? null : loadPendingSend(window.localStorage, loadHumanProfile()?.id));
  const [resendingPending, setResendingPending] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [roomSettingsOpen, setRoomSettingsOpen] = useState(false);
  const [roomConfigurationOpen, setRoomConfigurationOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [rosterTrigger, setRosterTrigger] = useState<HTMLElement | null>(null);
  const [rosterSelectedAgentId, setRosterSelectedAgentId] = useState<ActiveAgentId | null>(null);
  const [agentListSort, setAgentListSort] = useState<AgentListSort>(() => loadAgentListSort(typeof window === "undefined" ? undefined : window.localStorage));
  const [workshopId, setWorkshopId] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<WorkshopResponse | null>(null);
  const [workshopLoading, setWorkshopLoading] = useState(false);
  const [workshopMissing, setWorkshopMissing] = useState(false);
  const [workshopError, setWorkshopError] = useState("");
  const [workshopRequestRevision, setWorkshopRequestRevision] = useState(0);
  const [improvementsView, setImprovementsView] = useState<ImprovementsRoute | null>(() => typeof window === "undefined" ? null : readImprovementsRoute());
  const [tasksView, setTasksView] = useState(false);
  const [continuationsView, setContinuationsView] = useState(false);
  const [investigationsView, setInvestigationsView] = useState(false);
  const [contributionsView, setContributionsView] = useState(false);
  const [diagnosticsView, setDiagnosticsView] = useState(false);
  const [clientError, setClientError] = useState("");
  const [connectionNotice, setConnectionNotice] = useState("");
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [polls, setPolls] = useState<PublicPollProjection[]>([]);
  const pollRequestSequence = useRef(0);
  const [pollVotePending, setPollVotePending] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [hasInitialState, setHasInitialState] = useState(false);
  const [minimumLoadingComplete, setMinimumLoadingComplete] = useState(false);
  const [human, setHuman] = useState<HumanPresence | null>(null);
  const [joinError, setJoinError] = useState("");
  const [joinPending, setJoinPending] = useState(false);
  const [joinRequestRevision, setJoinRequestRevision] = useState(0);
  const [actionPending, setActionPending] = useState<{ action: RoomAction; target: AgentId | "all" } | null>(null);
  const [actionFailure, setActionFailure] = useState<ActionFailure | null>(null);
  const [transcriptMagnification, setTranscriptMagnification] = useState(loadTranscriptMagnification);
  const [showTimestamps, setShowTimestamps] = useState(loadTranscriptTimestamps);
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerBoundaryHandle>(null);
  const workshopTrigger = useRef<HTMLButtonElement | null>(null);
  const roomSettingsTrigger = useRef<HTMLButtonElement | null>(null);
  const roomConfigurationTrigger = useRef<HTMLElement | null>(null);
  const profileTrigger = useRef<HTMLElement | null>(null);
  const roomRevealed = useRef(false);
  const serverInstance = useRef<string | undefined>(undefined);
  const roomPosition = useRef<RoomProtocolPosition | undefined>(undefined);
  const restoreDistance = useRef<number | undefined>(undefined);
  const styleSaveRevision = useRef(0);
  const joinRequestId = useRef(0);
  const actionRequestId = useRef(0);
  const actionInFlight = useRef(false);
  const focusRouteHeading = useRef(Boolean(improvementsView));

  useEffect(() => {
    if (!savedHuman) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    let requestPending = false;
    const effectRequestId = joinRequestId.current + 1;
    joinRequestId.current = effectRequestId;
    const connect = async () => {
      if (cancelled || requestPending) return;
      requestPending = true;
      setJoinPending(true);
      try {
        await checkReady();
        const joined = await joinRoom(savedHuman);
        if (cancelled || joinRequestId.current !== effectRequestId) return;
        setHuman(joined);
        saveHumanProfile(joined);
        setJoinError("");
      } catch (error) {
        if (cancelled || joinRequestId.current !== effectRequestId) return;
        setJoinError(error instanceof Error ? `${error.message} Automatic retry is scheduled.` : "Connection lost. Automatic retry is scheduled.");
        retryTimer = window.setTimeout(() => void connect(), reconnectDelayMs(attempt));
        attempt += 1;
      } finally {
        requestPending = false;
        if (!cancelled && joinRequestId.current === effectRequestId) setJoinPending(false);
      }
    };
    void connect();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [Boolean(savedHuman), joinRequestRevision]);

  // Polls are a separate, server-authoritative projection. Replacing this list
  // (rather than incrementing local tallies) makes reconnect and replay idempotent.
  useEffect(() => {
    if (!human || !connected) { setPolls([]); return; }
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      const requestSequence = ++pollRequestSequence.current;
      try { const result = await loadPolls(); if (!cancelled && requestSequence === pollRequestSequence.current) setPolls(Array.isArray(result?.items) ? result.items : []); } catch { /* the room connection owns recovery */ }
      finally { if (!cancelled) timer = window.setTimeout(() => void refresh(), 2_000); }
    };
    void refresh();
    return () => { cancelled = true; pollRequestSequence.current += 1; if (timer !== undefined) window.clearTimeout(timer); };
  }, [human?.id, connected, connectionEpoch]);

  useEffect(() => {
    if (!human) return;
    const currentHuman = human;
    let cancelled = false;
    let events: EventSource | undefined;
    let retryTimer: number | undefined;
    let watchdogTimer: number | undefined;
    let reconnectAttempt = 0;
    let disconnected = false;
    let noticeTimer: number | undefined;
    let lastEventAt = Date.now();

    const showTemporaryNotice = (notice: string) => {
      setConnectionNotice(notice);
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => setConnectionNotice(""), 4_000);
    };

    const scheduleReconnect = () => {
      if (cancelled || retryTimer !== undefined) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void reconnect();
      }, reconnectDelayMs(reconnectAttempt));
      reconnectAttempt += 1;
    };

    const connectEvents = () => {
      if (cancelled) return;
      events?.close();
      const source = new EventSource("/api/events");
      events = source;
      lastEventAt = Date.now();
      source.addEventListener("heartbeat", () => {
        if (source === events) lastEventAt = Date.now();
      });
      source.onmessage = (event) => {
        if (source !== events) return;
        lastEventAt = Date.now();
        let input: unknown;
        try {
          input = JSON.parse(event.data);
        } catch {
          beginResync(source);
          return;
        }
        let nextRoom: RoomState | undefined;
        const result = reconcileRoomEvent(roomRef.current, roomPosition.current, input);
        if (result.kind === "resync") {
          beginResync(source);
          return;
        }
        if (result.kind === "ignored") return;
        if (result.kind === "incompatible") {
          composer.current?.flush();
          const reloadMarker = `${result.instanceId}:${result.protocolVersion}`;
          const reloadKey = "all-my-friends-are-agents-protocol-reload";
          if (window.sessionStorage.getItem(reloadKey) !== reloadMarker) {
            window.sessionStorage.setItem(reloadKey, reloadMarker);
            window.location.reload();
            return;
          }
          setClientError("The room updated to an incompatible version. Reload after the server and web client finish updating.");
          source.close();
          return;
        }
        nextRoom = result.room;
        roomPosition.current = result.position;
        window.sessionStorage.removeItem("all-my-friends-are-agents-protocol-reload");
        const previousInstance = serverInstance.current;
        if (nextRoom.server?.instanceId) serverInstance.current = nextRoom.server.instanceId;
        setRoom(nextRoom);
        setPendingSend((current) => current && nextRoom!.messages.some((message) => message.clientMessageId === current.clientMessageId && !message.id.startsWith("pending-")) ? null : current);
        setHasInitialState(true);
        setConnected(true);
        setClientError("");
        reconnectAttempt = 0;
        if (disconnected) {
          setConnectionEpoch((current) => current + 1);
          if (previousInstance && nextRoom.server?.instanceId && previousInstance !== nextRoom.server.instanceId) {
            showTemporaryNotice("Server updated — reconnected.");
          } else {
            showTemporaryNotice("Reconnected.");
          }
        }
        disconnected = false;
      };
      const beginResync = (failedSource: EventSource) => {
        if (failedSource !== events) return;
        failedSource.close();
        events = undefined;
        roomPosition.current = undefined;
        if (!disconnected) restoreDistance.current = scrollDistanceFromBottom(transcript.current);
        disconnected = true;
        setConnected(false);
        setConnectionNotice("Room stream changed — resynchronizing…");
        scheduleReconnect();
      };
      source.onerror = () => {
        if (source !== events) return;
        source.close();
        events = undefined;
        roomPosition.current = undefined;
        if (!disconnected) restoreDistance.current = scrollDistanceFromBottom(transcript.current);
        disconnected = true;
        setConnected(false);
        setConnectionNotice("Connection lost — reconnecting…");
        scheduleReconnect();
      };
    };

    async function reconnect() {
      try {
        await checkReady();
        if (cancelled) return;
        const joined = await joinRoom(currentHuman);
        if (cancelled) return;
        if (joined.id !== currentHuman.id) {
          composer.current?.flush();
          saveDraftSnapshot(window.localStorage, joined.id, loadDraftSnapshot(window.localStorage, currentHuman.id));
          savePendingSend(window.localStorage, joined.id, loadPendingSend(window.localStorage, currentHuman.id));
        }
        setHuman(joined);
        setSavedHuman(joined);
        saveHumanProfile(joined);
        if (joined.id !== currentHuman.id) return;
        connectEvents();
      } catch (error) {
        if (cancelled) return;
        setConnectionNotice("Connection lost — reconnecting…");
        scheduleReconnect();
      }
    }

    setConnected(false);
    setHasInitialState(false);
    roomPosition.current = undefined;
    connectEvents();
    watchdogTimer = window.setInterval(() => {
      const source = events;
      if (!source || Date.now() - lastEventAt <= ROOM_EVENT_STALE_MS) return;
      source.close();
      events = undefined;
      if (!disconnected) restoreDistance.current = scrollDistanceFromBottom(transcript.current);
      disconnected = true;
      setConnected(false);
      setConnectionNotice("Connection lost — reconnecting…");
      scheduleReconnect();
    }, 1_000);
    void loadRoom().then((next) => {
      if (!cancelled) setRoom((current) => ({ ...current, availability: next.availability || current.availability }));
    }).catch(() => {
      // The SSE initial snapshot is authoritative; this request only enriches CLI availability.
    });
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (watchdogTimer !== undefined) window.clearInterval(watchdogTimer);
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
      events?.close();
    };
  }, [human?.id]);

  useEffect(() => {
    if (!human) return;
    setPendingSend(loadPendingSend(window.localStorage, human.id));
  }, [human?.id]);

  useEffect(() => {
    if (human) savePendingSend(window.localStorage, human.id, pendingSend);
  }, [human?.id, pendingSend]);

  useEffect(() => {
    const timer = window.setTimeout(() => setMinimumLoadingComplete(true), MINIMUM_LOADING_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const updateRoute = (moveFocus = true) => { focusRouteHeading.current = moveFocus; setImprovementsView(readImprovementsRoute()); };
    const resolveAlias = () => {
      const alias = window.location.hash.slice(1);
      if (!alias || readImprovementsRoute()) return;
      // Hash aliases are accepted only after the API verifies the exact canonical ID.
      void resolveImprovementsAlias(alias, loadImprovement).then((resolved) => {
        if (!resolved) return;
        if (resolved.view === "detail") {
          window.history.replaceState({}, "", `/improvements/${encodeURIComponent(alias)}`);
          updateRoute(true);
        } else { focusRouteHeading.current = true; setImprovementsView(resolved); }
      });
    };
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="/improvements"]');
      if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || anchor.target || anchor.hasAttribute("download") || anchor.origin !== window.location.origin) return;
      event.preventDefault();
      window.history.pushState({}, "", anchor.href);
      updateRoute(event.detail === 0);
    };
    resolveAlias();
    const onPopState = () => updateRoute(true);
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", resolveAlias);
    document.addEventListener("click", onClick);
    return () => { window.removeEventListener("popstate", onPopState); window.removeEventListener("hashchange", resolveAlias); document.removeEventListener("click", onClick); };
  }, []);

  useEffect(() => {
    if (!workshopId) return;
    let cancelled = false;
    setWorkshop(null); setWorkshopMissing(false); setWorkshopError(""); setWorkshopLoading(true);
    void loadWorkshop(workshopId).then((data) => { if (!cancelled) setWorkshop(data); }).catch((error) => {
      if (cancelled) return;
      if (error instanceof ApiRequestError && error.status === 404) setWorkshopMissing(true);
      else setWorkshopError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (!cancelled) setWorkshopLoading(false); });
    return () => { cancelled = true; };
  }, [workshopId, workshopRequestRevision]);

  const ready = hasInitialState && minimumLoadingComplete;

  useLayoutEffect(() => {
    if (!ready) return;
    if (restoreDistance.current !== undefined) {
      restoreScrollDistance(transcript.current, restoreDistance.current);
      restoreDistance.current = undefined;
      roomRevealed.current = true;
      return;
    }
    scrollTranscriptToEnd(transcript.current, roomRevealed.current ? preferredScrollBehavior() : "auto");
    roomRevealed.current = true;
  }, [ready, connectionEpoch]);

  const activeAgentSet = new Set(Object.values(room.activeGenerations || {}));
  const activeTypingAgents = [...activeAgentSet];
  const working = activeAgentSet.size > 0;

  async function saveRoomSettings(settings: RoomSettingsInput) {
    await updateSettings(settings);
    setRoom((current) => ({ ...current, settings: { ...current.settings, ...settings } }));
  }

  function changeMyStyle(style: ChatStyle) {
    if (!human) return;
    const previousHuman = human;
    const nextHuman = { ...human, style: sanitizeChatStyle(style, human.style) };
    const revision = styleSaveRevision.current + 1;
    styleSaveRevision.current = revision;
    setHuman(nextHuman);
    setSavedHuman(nextHuman);
    saveHumanProfile(nextHuman);
    setClientError("");
    void updateMyStyle(nextHuman.style).catch((error) => {
      if (styleSaveRevision.current !== revision) return;
      setHuman(previousHuman);
      setSavedHuman(previousHuman);
      saveHumanProfile(previousHuman);
      setClientError(error instanceof Error ? error.message : String(error));
    });
  }

  async function changeMyProfile(profile: { name: string; avatarUrl?: string }) {
    if (!human) throw new Error("Join the room before changing your profile.");
    const previousHuman = human;
    const nextHuman = { ...human, ...profile };
    setProfileSaving(true);
    setHuman(nextHuman);
    setSavedHuman(nextHuman);
    saveHumanProfile(nextHuman);
    setClientError("");
    try {
      const saved = await updateMyProfile(profile);
      setHuman(saved);
      setSavedHuman(saved);
      saveHumanProfile(saved);
    } catch (error) {
      setHuman(previousHuman);
      setSavedHuman(previousHuman);
      saveHumanProfile(previousHuman);
      setClientError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setProfileSaving(false);
    }
  }

  function changeTranscriptMagnification(direction: -1 | 1) {
    setTranscriptMagnification((current) => {
      const next = adjacentTranscriptMagnification(current, direction);
      saveTranscriptMagnification(next);
      return next;
    });
  }

  function resetTranscriptMagnification() {
    saveTranscriptMagnification(100);
    setTranscriptMagnification(100);
  }

  function toggleTranscriptTimestamps() {
    setShowTimestamps((current) => {
      const next = !current;
      saveTranscriptTimestamps(next);
      return next;
    });
  }

  useEffect(() => {
    const onTranscriptShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        changeTranscriptMagnification(1);
      } else if (event.key === "-") {
        event.preventDefault();
        changeTranscriptMagnification(-1);
      } else if (event.key === "0") {
        event.preventDefault();
        resetTranscriptMagnification();
      }
    };
    document.addEventListener("keydown", onTranscriptShortcut);
    return () => document.removeEventListener("keydown", onTranscriptShortcut);
  }, []);

  async function submitMessage({ text: message, mentions }: ComposerSubmission) {
    if (!message || !human || !connected) return { restoreOnFailure: false };
    const clientMessageId = `message_${crypto.randomUUID()}`;
    const optimisticId = `pending-${clientMessageId}`;
    // Slash commands are private control requests until the server projects an
    // authoritative public outcome. Never flash the raw invocation in chat.
    const isCommand = message.trimStart().startsWith("/");
    if (!isCommand) setRoom((current) => appendOptimisticHumanMessage(current, human, optimisticId, message, new Date().toISOString(), mentions, clientMessageId));
    try {
      setClientError("");
      const acknowledgement = await sendMessage(message, clientMessageId, mentions);
      if ("command" in acknowledgement) {
        if (!isCommand) setRoom((current) => discardOptimisticMessage(current, optimisticId));
        if (acknowledgement.result.kind === "private-error") {
          const notice = acknowledgement.result.message || "The command was rejected.";
          setConnectionNotice(notice);
          window.setTimeout(() => setConnectionNotice((current) => current === notice ? "" : current), 4_000);
        }
      }
      return { restoreOnFailure: false };
    } catch (error) {
      const delivered = roomRef.current.messages.some(({ clientMessageId: deliveredId, id }) =>
        deliveredId === clientMessageId && !id.startsWith("pending-")
      );
      if (!isCommand) setRoom((current) => discardOptimisticMessage(current, optimisticId));
      if (error instanceof ApiRequestError && error.outcomeUnknown && !delivered) {
        setPendingSend({ clientMessageId, text: message, mentions });
      }
      setClientError(error instanceof Error ? error.message : String(error));
      return { restoreOnFailure: !(error instanceof ApiRequestError && error.outcomeUnknown) };
    }
  }

  function vote(pollId: string, optionIndex: number) {
    if (pollVotePending || !connected) return;
    setPollVotePending(`${pollId}:${optionIndex}`);
    void voteOnPoll(pollId, optionIndex).then(async () => {
      const requestSequence = ++pollRequestSequence.current;
      try {
        const result = await loadPolls();
        if (requestSequence === pollRequestSequence.current) setPolls(Array.isArray(result?.items) ? result.items : []);
      } catch { /* the periodic refresh owns poll projection recovery */ }
    }).catch((error) => {
      setClientError(error instanceof Error ? error.message : "The poll vote could not be submitted.");
    }).finally(() => setPollVotePending(null));
  }

  function resendPending() {
    if (!pendingSend || !human || !connected || resendingPending) return;
    const pending = pendingSend;
    setResendingPending(true);
    void (async () => {
      try {
        setClientError("");
        await sendMessage(pending.text, pending.clientMessageId, pending.mentions || []);
        setPendingSend(null);
      } catch (error) {
        setClientError(error instanceof Error ? error.message : String(error));
      } finally {
        setResendingPending(false);
      }
    })();
  }

  function returnPendingToDraft() {
    if (!pendingSend) return;
    composer.current?.restoreDraft(pendingSend.text, pendingSend.mentions || []);
    setPendingSend(null);
  }

  function invoke(action: RoomAction, agent: AgentId | "all", attempt = 0) {
    if (!human || !connected || actionInFlight.current) return;
    const requestId = actionRequestId.current + 1;
    actionRequestId.current = requestId;
    actionInFlight.current = true;
    setActionPending({ action, target: agent });
    setActionFailure(null);
    setClientError("");
    void runAction(action, agent).catch((error) => {
      if (actionRequestId.current !== requestId) return;
      setActionFailure({
        action,
        target: agent,
        attempt,
        message: error instanceof Error ? error.message : String(error),
        retrySafe: !(error instanceof ApiRequestError && error.outcomeUnknown),
      });
    }).finally(() => {
      if (actionRequestId.current !== requestId) return;
      actionInFlight.current = false;
      setActionPending(null);
    });
  }

  function joinWithName(name: string) {
    setJoinError("");
    const profile = { id: crypto.randomUUID(), name, style: DEFAULT_PARTICIPANT_STYLES.you };
    setSavedHuman(profile);
  }

  function retryJoin() {
    if (joinPending) return;
    setJoinRequestRevision((current) => current + 1);
  }

  function cancelJoin() {
    joinRequestId.current += 1;
    setJoinPending(false);
    setJoinError("");
    setSavedHuman(null);
    saveHumanProfile(null);
  }

  function navigateImprovements(next: ImprovementsRoute | null, options: { focusHeading?: boolean } = {}) {
    setWorkshopId(null);
    focusRouteHeading.current = options.focusHeading ?? Boolean(!next || next.view === "missing" || next.view === "detail");
    if (!next) {
      if (!improvementsView) return;
      window.history.pushState({}, "", "/");
      setImprovementsView(null);
      return;
    }
    const path = next.view === "list" ? `/improvements${next.scope === "all" ? "?scope=all" : ""}` : `/improvements/${encodeURIComponent(next.id)}`;
    window.history.pushState({}, "", path);
    setImprovementsView(next);
  }

  function showChat() {
    setTasksView(false);
    setContinuationsView(false);
    setInvestigationsView(false);
    setContributionsView(false);
    setDiagnosticsView(false);
    navigateImprovements(null);
  }

  const statusText = working
    ? activeTypingAgents.length === 1
      ? `${agentScreenName(activeTypingAgents[0])} is typing...`
      : "Agents are typing..."
    : room.status === "error"
      ? "Room needs attention"
      : "Room is idle";
  const chatActive = !improvementsView && !tasksView && !continuationsView && !investigationsView && !contributionsView && !diagnosticsView;
  const roster = normalizeRoomAgentRoster(room.roster);
  const enabledAgents = enabledRoomAgentIds(roster);
  const peopleHere = (room.humans?.length || 0) + enabledAgents.filter((agent) => room.availability?.[agent] !== false).length;
  const mentionCandidates = useMemo(() => roomMentionCandidates(room.humans || [], enabledAgents), [room.humans, room.roster]);
  const openRoster = useCallback((trigger: HTMLElement, selectedAgentId?: ActiveAgentId) => {
    setRosterTrigger(trigger);
    setRosterSelectedAgentId(selectedAgentId || null);
    setRosterOpen(true);
  }, []);
  const openProfile = useCallback((trigger: HTMLElement) => {
    profileTrigger.current = trigger;
    setProfileOpen(true);
  }, []);
  const changeAgentListSort = useCallback((sort: AgentListSort) => {
    setAgentListSort(sort);
    saveAgentListSort(typeof window === "undefined" ? undefined : window.localStorage, sort);
  }, []);
  const openRoomSettings = useCallback((trigger: HTMLButtonElement) => {
    roomSettingsTrigger.current = trigger;
    setRoomSettingsOpen(true);
  }, []);
  const openRoomConfiguration = useCallback((trigger: HTMLElement) => {
    roomConfigurationTrigger.current = trigger;
    setRoomConfigurationOpen(true);
  }, []);
  const openImprovement = useCallback((id: string, trigger: HTMLButtonElement) => {
    workshopTrigger.current = trigger;
    setWorkshopRequestRevision((current) => current + 1);
    setWorkshopId((current) => nextWorkshopId(current, { type: "open", id }));
  }, []);

  const menus: ClassicMenuDefinition[] = [
    {
      id: "you",
      label: "You",
      accessKey: "Y",
      items: [
        { label: "Profile...", accessKey: "P", onSelect: openProfile },
      ],
    },
    {
      id: "room",
      label: "Room",
      accessKey: "R",
      items: [
        { label: "Room properties...", accessKey: "P", onSelect: openRoomSettings },
        { label: "Room settings...", accessKey: "S", onSelect: openRoomConfiguration },
        { label: "Manage agents...", accessKey: "M", onSelect: openRoster },
        { type: "separator" },
        { label: "Continue discussion", accessKey: "d", disabled: true, onSelect: () => { setContributionsView(false); setInvestigationsView(false); invoke("continue", "all"); } },
        { label: "Start roundtable", accessKey: "S", disabled: true, onSelect: () => { setContributionsView(false); setInvestigationsView(false); invoke("roundtable", "all"); } },
        { label: "Review with all agents", accessKey: "R", disabled: true, onSelect: () => { setContributionsView(false); setInvestigationsView(false); invoke("review", "all"); } },
      ],
    },
    {
      id: "view",
      label: "View",
      accessKey: "V",
      items: [
        { label: "Timestamps", accessKey: "T", checked: showTimestamps, checkType: "checkbox", onSelect: toggleTranscriptTimestamps },
        { type: "separator" },
        { label: "Diagnostics", accessKey: "D", checked: diagnosticsView, onSelect: () => { if (diagnosticsView) return; setDiagnosticsView(true); setInvestigationsView(false); setTasksView(false); setContinuationsView(false); setContributionsView(false); navigateImprovements(null); } },
        { type: "separator" },
        { label: "Larger transcript", accessKey: "L", shortcut: "Ctrl++", disabled: transcriptMagnification >= 150, onSelect: () => changeTranscriptMagnification(1) },
        { label: "Smaller transcript", accessKey: "S", shortcut: "Ctrl+-", disabled: transcriptMagnification <= 75, onSelect: () => changeTranscriptMagnification(-1) },
        { label: "Actual size", accessKey: "A", shortcut: "Ctrl+0", disabled: transcriptMagnification === 100, onSelect: resetTranscriptMagnification },
      ],
    },
    {
      id: "window",
      label: "Window",
      accessKey: "W",
      disabled: true,
      items: [
        { label: "Chat", accessKey: "C", checked: chatActive, onSelect: () => { if (!chatActive) showChat(); } },
        { label: "Improvements", accessKey: "I", checked: Boolean(improvementsView), onSelect: () => { if (improvementsView) return; setTasksView(false); setContinuationsView(false); setInvestigationsView(false); setContributionsView(false); setDiagnosticsView(false); navigateImprovements({ view: "list", scope: "active" }); } },
        { label: "Tasks", accessKey: "T", checked: tasksView, onSelect: () => { if (tasksView) return; setTasksView(true); setContinuationsView(false); setInvestigationsView(false); setContributionsView(false); setDiagnosticsView(false); navigateImprovements(null); } },
        { label: "Continuations", accessKey: "o", checked: continuationsView, onSelect: () => { if (continuationsView) return; setContinuationsView(true); setTasksView(false); setInvestigationsView(false); setContributionsView(false); setDiagnosticsView(false); navigateImprovements(null); } },
        { label: "Investigations", accessKey: "n", checked: investigationsView, onSelect: () => { if (investigationsView) return; setInvestigationsView(true); setContinuationsView(false); setTasksView(false); setContributionsView(false); setDiagnosticsView(false); navigateImprovements(null); } },
        { label: "Reviewed contributions", accessKey: "R", checked: contributionsView, onSelect: () => { if (contributionsView) return; setContributionsView(true); setInvestigationsView(false); setTasksView(false); setContinuationsView(false); setDiagnosticsView(false); navigateImprovements(null); } },
        { label: "Diagnostics", accessKey: "D", checked: diagnosticsView, onSelect: () => { if (diagnosticsView) return; setDiagnosticsView(true); setInvestigationsView(false); setTasksView(false); setContinuationsView(false); setContributionsView(false); navigateImprovements(null); } },
      ],
    },
    {
      id: "help",
      label: "Help",
      accessKey: "H",
      items: [
        { label: "Help topics", accessKey: "H", shortcut: "F1", onSelect: () => { setRoomSettingsOpen(false); setHelpOpen(true); } },
      ],
    },
  ];

  useEffect(() => {
    const routeTitle = !improvementsView ? room.settings.roomName : improvementsView.view === "detail" ? improvementsView.id : improvementsView.view === "missing" ? "Improvement not found" : `Improvements — ${improvementsView.scope === "all" ? "All" : "Active"}`;
    document.title = `AllMyFriendsAreAgents — ${routeTitle}`;
  }, [room.settings.roomName, improvementsView]);

  useEffect(() => {
    if (!focusRouteHeading.current) return;
    const heading = document.querySelector<HTMLElement>("[data-route-heading]");
    if (heading) heading.focus();
    focusRouteHeading.current = false;
  }, [improvementsView]);

  if (!savedHuman) return <NameEntry error={joinError} onJoin={joinWithName} />;
  if (!human) return <LoadingScreen error={joinError || "Joining the room"} joining={Boolean(joinError)} retrying={joinPending} onRetry={retryJoin} onCancel={cancelJoin} />;
  if (!ready) return <LoadingScreen error={clientError} />;

  return (
    <main className="desktop">
      <section className="app-window" aria-label="AllMyFriendsAreAgents application">
        <header className="window-titlebar">
          <span className="app-icon" aria-hidden="true">AW</span>
          <h1><span className="title-long">AllMyFriendsAreAgents — </span>{room.settings.roomName}</h1>
        </header>
        <ClassicMenuBar menus={menus} onHelp={() => { setRoomSettingsOpen(false); setHelpOpen(true); }} />

        {connectionNotice ? <div className="connection-banner" role="status" aria-live="polite" aria-atomic="true">{connectionNotice}</div> : null}
        <div className={`workspace${chatActive ? "" : " workspace--single"}`} data-primary-workspace tabIndex={-1}>
          {improvementsView ? <Improvements route={improvementsView} onNavigate={navigateImprovements} /> : diagnosticsView ? <Diagnostics agents={enabledAgents} /> : investigationsView ? <Investigations refreshKey={connectionEpoch} /> : contributionsView ? <Contributions refreshKey={connectionEpoch} /> : continuationsView ? <Continuations refreshKey={connectionEpoch} /> : tasksView ? <Tasks refreshKey={connectionEpoch} /> : <>
          <section className="chat-panel beveled-inset">
            <Transcript messages={room.messages} magnification={transcriptMagnification} showTimestamps={showTimestamps} transcriptRef={transcript} onOpenImprovement={openImprovement} />
            <PollCards polls={polls} disabled={!connected || Boolean(pollVotePending)} onVote={vote} />
          </section>
          <div className="right-rail">
            <RoomRoster roster={roster} agents={enabledAgents} agentListSort={agentListSort} availability={room.availability} agentHealth={room.agentHealth} activeAgents={activeAgentSet} humans={room.humans || []} currentHumanId={human.id} onConfigureHumanAvatar={openProfile} onOpenRoomProperties={openRoomSettings} onManageRoster={openRoster} />
          </div>
          <div className="chat-composer">
            {pendingSend ? (
              <div className="pending-send" role="status">
                <span><strong>Not sent — send now?</strong> {pendingSend.text}</span>
                <button type="button" className="classic-button" disabled={!connected || resendingPending} onClick={resendPending}>{resendingPending ? "Sending…" : "Send now"}</button>
                <button type="button" className="classic-button" disabled={resendingPending} onClick={returnPendingToDraft}>Keep as draft</button>
              </div>
            ) : null}
            <ComposerBoundary
              key={human.id}
              ref={composer}
              humanId={human.id}
              mentionCandidates={mentionCandidates}
              style={human.style}
              sendDisabled={!connected}
              onStyleChange={changeMyStyle}
              onSubmit={submitMessage}
            />
          </div>
          </>}
        </div>

        {roomSettingsOpen ? <RoomSettingsDialog roomName={room.settings.roomName} topic={room.settings.topic} conversationEnergy={room.settings.conversationEnergy} disabled={!connected} returnFocusTo={roomSettingsTrigger.current} onSave={saveRoomSettings} onClose={() => setRoomSettingsOpen(false)} /> : null}
        {roomConfigurationOpen ? <RoomConfigurationDialog returnFocusTo={roomConfigurationTrigger.current} onClose={() => setRoomConfigurationOpen(false)} /> : null}
        {profileOpen ? <HumanProfileDialog human={human} busy={profileSaving} returnFocusTo={profileTrigger.current} onProfileChange={changeMyProfile} onClose={() => setProfileOpen(false)} /> : null}

        {rosterOpen ? <RosterManagerDialog
          initialRoster={roster}
          initialSelectedAgentId={rosterSelectedAgentId || undefined}
          agentListSort={agentListSort}
          onAgentListSortChange={changeAgentListSort}
          returnFocusTo={rosterTrigger}
          onSaved={(nextRoster) => setRoom((current) => ({ ...current, roster: nextRoster }))}
          onClose={() => setRosterOpen(false)}
        /> : null}
        {workshopId ? <WorkshopDialog data={workshop} loading={workshopLoading} missing={workshopMissing} error={workshopError} connected={connected} returnFocusTo={workshopTrigger.current} onRetry={() => setWorkshopRequestRevision((current) => current + 1)} onClose={() => setWorkshopId((current) => nextWorkshopId(current, { type: "close" }))} /> : null}
        {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}

        {actionPending ? <div className="error-strip error-strip--pending" role="status"><span>{roomActionLabel(actionPending.action, actionPending.target)} is being requested. Other room actions are unavailable until it finishes.</span></div> : null}
        {actionFailure ? <div className="error-strip" role="alert">
          <span><strong>{roomActionLabel(actionFailure.action, actionFailure.target)} failed.</strong> {actionFailure.message} {!connected ? "Retry is unavailable while reconnecting." : !actionFailure.retrySafe ? "The result may be unknown, so retrying could duplicate the action." : actionFailure.attempt > 0 ? "The retry failed; close this error or choose a new action." : ""}</span>
          {actionFailure.retrySafe && actionFailure.attempt === 0 ? <button type="button" className="error-strip__retry" disabled={!connected || Boolean(actionPending)} onClick={() => invoke(actionFailure.action, actionFailure.target, 1)}>Retry once</button> : null}
          <button type="button" aria-label="Dismiss action error" disabled={Boolean(actionPending)} onClick={() => setActionFailure(null)}>×</button>
        </div> : clientError || room.error ? <div className="error-strip" role="alert"><span>{clientError || room.error}</span>{clientError ? <button type="button" aria-label="Dismiss error" onClick={() => setClientError("")}>×</button> : null}</div> : null}
        <footer className="status-bar">
          <div className="status-cell"><span className="people-icon" aria-hidden="true">♟♟♟♟♟</span> {peopleHere} here</div>
          <div className="status-cell">{statusText}</div>
          <div className="status-cell status-cell--connection"><span className="connection-lights"><i /><i /><i /></span> {connected ? "Connected" : "Reconnecting..."}</div>
        </footer>
      </section>
    </main>
  );
}

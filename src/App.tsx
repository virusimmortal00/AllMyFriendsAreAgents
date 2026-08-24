import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ApiRequestError, checkReady, joinRoom, loadImprovement, loadRoom, loadWorkshop, runAction, sendMessage, updateMyStyle, updateSettings } from "./api";
import { AgentSettingsDialog, ConfirmationDialog, HelpDialog, RoomControls, RoomRoster, Transcript, TranscriptHeader, WorkshopDialog, type RoomSettingsInput } from "./components";
import { ComposerBoundary, type ComposerBoundaryHandle, type ComposerSubmission } from "./composer";
import { scrollTranscriptToEnd } from "./scroll";
import { appendOptimisticHumanMessage, discardOptimisticMessage } from "./optimistic-message";
import { adjacentTranscriptMagnification, loadTranscriptMagnification, saveTranscriptMagnification } from "./transcript-view";
import { loadDraftSnapshot, loadPendingSend, saveDraftSnapshot, savePendingSend, type PendingSend } from "./client-persistence";
import { reconnectDelayMs, restoreScrollDistance, scrollDistanceFromBottom } from "./reconnect";
import { nextWorkshopId } from "./workshop-dialog";
import { DEFAULT_PARTICIPANT_STYLES, sanitizeChatStyle, type ChatStyle } from "../shared/chat-style";
import { AGENT_IDS, agentScreenName, type ActiveAgentId } from "../shared/participants";
import { ROOM_PROTOCOL_VERSION } from "../shared/protocol";
import type { AgentId, HumanPresence, RoomState, WorkshopResponse, WritableAgent } from "./types";
import { Improvements, ImprovementsMenuControl, improvementsRoute as readImprovementsRoute, resolveImprovementsAlias, type ImprovementsRoute } from "./improvements";
import { roomMentionCandidates } from "../shared/mentions";
import { useDismissibleLayer, useModalOverlay } from "./overlay";

const EMPTY_ROOM: RoomState = {
  messages: [],
  settings: {
    roomName: "The Agent Room",
    topic: "Open conversation",
    writableAgent: "nobody",
    conversationEnergy: "balanced",
    participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
  },
  status: "idle",
};
const MINIMUM_LOADING_MS = 450;
const HUMAN_PROFILE_KEY = "all-my-friends-are-agents-human";
const ROOM_EVENT_STALE_MS = 9_000;

function loadHumanProfile(): HumanPresence | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(HUMAN_PROFILE_KEY) || "null") as Partial<HumanPresence> | null;
    if (!value?.id || !value.name) return null;
    return {
      id: value.id,
      name: value.name,
      style: sanitizeChatStyle(value.style, DEFAULT_PARTICIPANT_STYLES.you),
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

export function LoadingScreen({ error = "" }: { error?: string }) {
  return (
    <main className="desktop">
      <section className="loading-window" aria-label="AllMyFriendsAreAgents loading">
        <header className="window-titlebar">
          <span className="app-icon" aria-hidden="true">AW</span>
          <h1>AllMyFriendsAreAgents</h1>
          <div className="window-buttons window-buttons--decorative" aria-hidden="true"><span>_</span><span>□</span><span>×</span></div>
        </header>
        <div className="loading-dialog" role="status" aria-live="polite">
          <span className="retro-spinner" aria-hidden="true" />
          <strong>Entering The Agent Room...</strong>
          <span>{error || "Loading the latest conversation"}</span>
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
          <div className="window-buttons window-buttons--decorative" aria-hidden="true"><span>_</span><span>□</span><span>×</span></div>
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
  const [room, setRoom] = useState<RoomState>(EMPTY_ROOM);
  const [savedHuman, setSavedHuman] = useState(loadHumanProfile);
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(() => typeof window === "undefined" ? null : loadPendingSend(window.localStorage, loadHumanProfile()?.id));
  const [resendingPending, setResendingPending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [changeNameOpen, setChangeNameOpen] = useState(false);
  const [changeNameBusy, setChangeNameBusy] = useState(false);
  const [changeNameConsequences, setChangeNameConsequences] = useState({ hasDraft: false, hasPending: false });
  const [mobilePanel, setMobilePanel] = useState<"people" | "room" | null>(null);
  const [compactLayout, setCompactLayout] = useState(() => typeof window !== "undefined" && window.innerWidth <= 720);
  const [configuredAgent, setConfiguredAgent] = useState<ActiveAgentId | null>(null);
  const [workshopId, setWorkshopId] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<WorkshopResponse | null>(null);
  const [workshopLoading, setWorkshopLoading] = useState(false);
  const [workshopMissing, setWorkshopMissing] = useState(false);
  const [improvementsView, setImprovementsView] = useState<ImprovementsRoute | null>(() => typeof window === "undefined" ? null : readImprovementsRoute());
  const [clientError, setClientError] = useState("");
  const [connectionNotice, setConnectionNotice] = useState("");
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [connected, setConnected] = useState(false);
  const [hasInitialState, setHasInitialState] = useState(false);
  const [minimumLoadingComplete, setMinimumLoadingComplete] = useState(false);
  const [human, setHuman] = useState<HumanPresence | null>(null);
  const [joinError, setJoinError] = useState("");
  const [transcriptMagnification, setTranscriptMagnification] = useState(loadTranscriptMagnification);
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerBoundaryHandle>(null);
  const workshopTrigger = useRef<HTMLButtonElement | null>(null);
  const changeNameTrigger = useRef<HTMLButtonElement | null>(null);
  const changeNameSubmitting = useRef(false);
  const roomRevealed = useRef(false);
  const serverInstance = useRef<string | undefined>(undefined);
  const restoreDistance = useRef<number | undefined>(undefined);
  const styleSaveRevision = useRef(0);
  const focusRouteHeading = useRef(Boolean(improvementsView));
  const actionsMenuFocusLast = useRef(false);
  const { layerRef: actionsMenu, triggerRef: actionsTrigger } = useDismissibleLayer(menuOpen, () => setMenuOpen(false));
  const panelOverlayOpen = Boolean(mobilePanel && compactLayout);
  const { dialogRef: sidePanelRef, onDialogKeyDown: onSidePanelKeyDown } = useModalOverlay<HTMLDivElement>(() => setMobilePanel(null), null, panelOverlayOpen);

  useEffect(() => {
    const updateCompactLayout = () => setCompactLayout(window.innerWidth <= 720);
    window.addEventListener("resize", updateCompactLayout);
    return () => window.removeEventListener("resize", updateCompactLayout);
  }, []);

  useEffect(() => {
    if (!savedHuman) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    const connect = async () => {
      try {
        await checkReady();
        const joined = await joinRoom(savedHuman);
        if (cancelled) return;
        setHuman(joined);
        saveHumanProfile(joined);
        setJoinError("");
      } catch (error) {
        if (cancelled) return;
        setJoinError(error instanceof Error ? `${error.message} Retrying…` : "Connection lost. Retrying…");
        retryTimer = window.setTimeout(() => void connect(), reconnectDelayMs(attempt));
        attempt += 1;
      }
    };
    void connect();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [savedHuman?.id, savedHuman?.name]);

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
      const source = new EventSource(`/api/events?humanId=${encodeURIComponent(currentHuman.id)}`);
      events = source;
      lastEventAt = Date.now();
      source.addEventListener("heartbeat", () => {
        if (source === events) lastEventAt = Date.now();
      });
      source.onmessage = (event) => {
        if (source !== events) return;
        lastEventAt = Date.now();
        const next = JSON.parse(event.data) as RoomState;
        if (next.server && next.server.protocolVersion !== ROOM_PROTOCOL_VERSION) {
          composer.current?.flush();
          const reloadMarker = `${next.server.instanceId}:${next.server.protocolVersion}`;
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
        window.sessionStorage.removeItem("all-my-friends-are-agents-protocol-reload");
        const previousInstance = serverInstance.current;
        if (next.server?.instanceId) serverInstance.current = next.server.instanceId;
        setRoom((current) => ({ ...next, availability: current.availability, agentHealth: next.agentHealth || current.agentHealth }));
        setPendingSend((current) => current && next.messages.some((message) => message.clientMessageId === current.clientMessageId) ? null : current);
        setHasInitialState(true);
        setConnected(true);
        setClientError("");
        reconnectAttempt = 0;
        if (disconnected) {
          setConnectionEpoch((current) => current + 1);
          if (previousInstance && next.server?.instanceId && previousInstance !== next.server.instanceId) {
            showTemporaryNotice("Server updated — reconnected.");
          } else {
            showTemporaryNotice("Reconnected.");
          }
        }
        disconnected = false;
      };
      source.onerror = () => {
        if (source !== events) return;
        source.close();
        events = undefined;
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
        await joinRoom(currentHuman);
        if (cancelled) return;
        connectEvents();
      } catch (error) {
        if (cancelled) return;
        setConnectionNotice("Connection lost — reconnecting…");
        scheduleReconnect();
      }
    }

    setConnected(false);
    setHasInitialState(false);
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
    setWorkshop(null); setWorkshopMissing(false); setWorkshopLoading(true);
    void loadWorkshop(workshopId).then((data) => { if (!cancelled) setWorkshop(data); }).catch(() => { if (!cancelled) setWorkshopMissing(true); }).finally(() => { if (!cancelled) setWorkshopLoading(false); });
    return () => { cancelled = true; };
  }, [workshopId]);

  const ready = hasInitialState && minimumLoadingComplete;

  useLayoutEffect(() => {
    if (!ready) return;
    if (restoreDistance.current !== undefined) {
      restoreScrollDistance(transcript.current, restoreDistance.current);
      restoreDistance.current = undefined;
      roomRevealed.current = true;
      return;
    }
    scrollTranscriptToEnd(transcript.current, roomRevealed.current ? "smooth" : "auto");
    roomRevealed.current = true;
  }, [ready, room.messages.length, connectionEpoch]);

  const working = room.status === "working";

  async function withErrorHandling(action: () => Promise<unknown>) {
    try {
      setClientError("");
      await action();
    } catch (error) {
      setClientError(error instanceof Error ? error.message : String(error));
    }
  }

  async function changeWritable(agent: WritableAgent) {
    if (!human) throw new Error("Join the room before changing project permissions.");
    await updateSettings({ writableAgent: agent, actorId: human.id });
    setRoom((current) => ({ ...current, settings: { ...current.settings, writableAgent: agent } }));
  }

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
    void updateMyStyle(human.id, nextHuman.style).catch((error) => {
      if (styleSaveRevision.current !== revision) return;
      setHuman(previousHuman);
      setSavedHuman(previousHuman);
      saveHumanProfile(previousHuman);
      setClientError(error instanceof Error ? error.message : String(error));
    });
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

  async function submitMessage({ text: message, mentions }: ComposerSubmission) {
    if (!message || !human || !connected) return { restoreOnFailure: false };
    const clientMessageId = `message_${crypto.randomUUID()}`;
    const optimisticId = `pending-${clientMessageId}`;
    setRoom((current) => appendOptimisticHumanMessage(current, human, optimisticId, message, new Date().toISOString(), mentions));
    try {
      setClientError("");
      const next = await sendMessage(human.id, message, clientMessageId, mentions);
      setRoom((current) => {
        const stillPending = current.messages.some(({ id }) => id === optimisticId);
        if (!stillPending && current.messages.length >= next.messages.length) return current;
        return { ...next, availability: current.availability, agentHealth: next.agentHealth || current.agentHealth };
      });
      return { restoreOnFailure: false };
    } catch (error) {
      setRoom((current) => discardOptimisticMessage(current, optimisticId));
      if (error instanceof ApiRequestError && error.outcomeUnknown) {
        setPendingSend({ clientMessageId, text: message, mentions });
      }
      setClientError(error instanceof Error ? error.message : String(error));
      return { restoreOnFailure: !(error instanceof ApiRequestError && error.outcomeUnknown) };
    }
  }

  function resendPending() {
    if (!pendingSend || !human || !connected || resendingPending) return;
    const pending = pendingSend;
    setResendingPending(true);
    void (async () => {
      try {
        setClientError("");
        const next = await sendMessage(human.id, pending.text, pending.clientMessageId, pending.mentions || []);
        setRoom((current) => ({ ...next, availability: current.availability, agentHealth: next.agentHealth || current.agentHealth }));
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

  function invoke(action: "ask" | "review" | "roundtable" | "continue", agent: AgentId | "all") {
    setMenuOpen(false);
    void withErrorHandling(() => runAction(action, agent));
  }

  function joinWithName(name: string) {
    setJoinError("");
    changeNameSubmitting.current = false;
    setChangeNameBusy(false);
    setChangeNameOpen(false);
    const profile = { id: crypto.randomUUID(), name, style: DEFAULT_PARTICIPANT_STYLES.you };
    setSavedHuman(profile);
  }

  function changeName() {
    if (!human || changeNameSubmitting.current) return;
    changeNameSubmitting.current = true;
    setChangeNameBusy(true);
    styleSaveRevision.current += 1;
    composer.current?.discardDraft();
    saveDraftSnapshot(window.localStorage, human.id, { text: "", mentions: [] });
    savePendingSend(window.localStorage, human.id, null);
    setPendingSend(null);
    setHuman(null);
    setSavedHuman(null);
    saveHumanProfile(null);
    setRoom(EMPTY_ROOM);
    setHasInitialState(false);
  }

  function navigateImprovements(next: ImprovementsRoute | null, options: { focusHeading?: boolean } = {}) {
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

  const statusText = working
    ? room.activeAgent
      ? `${agentScreenName(room.activeAgent)} is typing...`
      : "Agents are typing..."
    : room.status === "error"
      ? "Room needs attention"
      : "Room is idle";
  const peopleHere = (room.humans?.length || 0) + AGENT_IDS.filter((agent) => room.availability?.[agent] !== false).length;
  const mentionCandidates = useMemo(() => roomMentionCandidates(room.humans || []), [room.humans]);
  const openImprovement = useCallback((id: string, trigger: HTMLButtonElement) => {
    workshopTrigger.current = trigger;
    setWorkshopId((current) => nextWorkshopId(current, { type: "open", id }));
  }, []);

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

  useEffect(() => {
    if (!menuOpen) return;
    const items = [...(actionsMenu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])];
    items[actionsMenuFocusLast.current ? items.length - 1 : 0]?.focus();
    actionsMenuFocusLast.current = false;
  }, [menuOpen]);

  function onActionsMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...(actionsMenu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
      : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  }

  if (!savedHuman) return <NameEntry error={joinError} onJoin={joinWithName} />;
  if (!human) return <LoadingScreen error={joinError || "Joining the room"} />;
  if (!ready) return <LoadingScreen error={clientError} />;

  return (
    <main className="desktop">
      <section className="app-window" aria-label="AllMyFriendsAreAgents application">
        <header className="window-titlebar">
          <span className="app-icon" aria-hidden="true">AW</span>
          <h1><span className="title-long">AllMyFriendsAreAgents — </span>{room.settings.roomName}</h1>
          <div className="window-buttons window-buttons--decorative" aria-hidden="true"><span>_</span><span>□</span><span>×</span></div>
        </header>
        <nav className="menu-bar" aria-label="Application menu">
          <button
            type="button"
            aria-controls="room-side-panel"
            aria-expanded={mobilePanel === "room"}
            onClick={() => { setMobilePanel((panel) => panel === "room" ? null : "room"); navigateImprovements(null); }}
          >Room</button>
          <button
            type="button"
            aria-controls="room-side-panel"
            aria-expanded={mobilePanel === "people"}
            onClick={() => { setMobilePanel((panel) => panel === "people" ? null : "people"); navigateImprovements(null); }}
          >People</button>
          <button ref={changeNameTrigger} type="button" aria-haspopup="dialog" aria-expanded={changeNameOpen} onClick={() => {
            composer.current?.flush();
            setChangeNameConsequences({
              hasDraft: Boolean(loadDraftSnapshot(window.localStorage, human.id).text),
              hasPending: Boolean(pendingSend),
            });
            setChangeNameOpen(true);
          }}>Change name</button>
          <ImprovementsMenuControl active={Boolean(improvementsView)} onOpen={() => navigateImprovements(improvementsView ? null : { view: "list", scope: "active" })} />
          <div className="menu-wrap" ref={actionsMenu}>
            <button ref={actionsTrigger} type="button" aria-haspopup="menu" aria-expanded={menuOpen} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); actionsMenuFocusLast.current = event.key === "ArrowUp"; setMenuOpen(true); } }} onClick={() => { setMenuOpen((open) => !open); navigateImprovements(null); }}>Actions</button>
            {menuOpen ? (
              <div className="dropdown-menu" role="menu" aria-label="Actions" onKeyDown={onActionsMenuKeyDown}>
                <button type="button" role="menuitem" disabled={working || !connected} onClick={() => { setMenuOpen(false); actionsTrigger.current?.focus(); invoke("continue", "all"); }}>Continue discussion</button>
                <button type="button" role="menuitem" disabled={working || !connected} onClick={() => { setMenuOpen(false); actionsTrigger.current?.focus(); invoke("roundtable", "all"); }}>Start roundtable</button>
                <button type="button" role="menuitem" disabled={working || !connected} onClick={() => { setMenuOpen(false); actionsTrigger.current?.focus(); invoke("review", "all"); }}>Review with all agents</button>
              </div>
            ) : null}
          </div>
          <button type="button" aria-haspopup="dialog" aria-expanded={helpOpen} onClick={() => { setMenuOpen(false); setMobilePanel(null); setHelpOpen(true); }}>Help</button>
        </nav>

        {connectionNotice ? <div className="connection-banner" role="status" aria-live="polite" aria-atomic="true">{connectionNotice}</div> : null}
        <div className="workspace">
          {improvementsView ? <Improvements route={improvementsView} onNavigate={navigateImprovements} /> : <>
          <section className="chat-panel beveled-inset">
            <TranscriptHeader roomName={room.settings.roomName} magnification={transcriptMagnification} onMagnificationChange={changeTranscriptMagnification} onMagnificationReset={resetTranscriptMagnification} />
            <Transcript messages={room.messages} magnification={transcriptMagnification} transcriptRef={transcript} onOpenImprovement={openImprovement} />
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
          </section>
          {panelOverlayOpen ? (
            <button
              type="button"
              className="mobile-panel-backdrop"
              aria-label="Close side panel"
              onClick={() => setMobilePanel(null)}
            />
          ) : null}
          <div
            ref={sidePanelRef}
            id="room-side-panel"
            className={`right-rail${mobilePanel ? " right-rail--open" : ""}`}
            data-mobile-panel={mobilePanel || undefined}
            role={panelOverlayOpen ? "dialog" : undefined}
            aria-modal={panelOverlayOpen ? "true" : undefined}
            aria-labelledby={panelOverlayOpen ? "mobile-panel-title" : undefined}
            tabIndex={panelOverlayOpen ? -1 : undefined}
            onKeyDown={panelOverlayOpen ? onSidePanelKeyDown : undefined}
          >
            <header className="mobile-panel-header">
              <strong id="mobile-panel-title">{mobilePanel === "people" ? "People in this room" : "Room settings"}</strong>
              <button type="button" aria-label="Close side panel" onClick={() => setMobilePanel(null)}>×</button>
            </header>
            {!compactLayout || mobilePanel === "people" ? <RoomRoster availability={room.availability} agentHealth={room.agentHealth} humans={room.humans || []} currentHumanId={human.id} onConfigureAgent={setConfiguredAgent} /> : null}
            {!compactLayout || mobilePanel === "room" ? <RoomControls
              roomName={room.settings.roomName}
              topic={room.settings.topic}
              conversationEnergy={room.settings.conversationEnergy}
              disabled={working || !connected}
              onSave={saveRoomSettings}
            /> : null}
          </div>
          </>}
        </div>

        {configuredAgent ? (
          <AgentSettingsDialog
            agent={configuredAgent}
            available={room.availability?.[configuredAgent] !== false}
            health={room.agentHealth?.[configuredAgent]}
            writableAgent={room.settings.writableAgent}
            disabled={working || !connected}
            onWritableChange={changeWritable}
            onClose={() => setConfiguredAgent(null)}
          />
        ) : null}
        {workshopId ? <WorkshopDialog data={workshop} loading={workshopLoading} missing={workshopMissing} returnFocusTo={workshopTrigger.current} onClose={() => setWorkshopId((current) => nextWorkshopId(current, { type: "close" }))} /> : null}
        {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}
        {changeNameOpen && human ? <ConfirmationDialog
          title="Change your name?"
          description={<>
            <p>Changing your name resets your room identity and clears the current room state on this device.</p>
            {changeNameConsequences.hasPending ? <p><strong>Your unsent message will be deleted.</strong></p> : null}
            {changeNameConsequences.hasDraft ? <p><strong>Your saved draft will be deleted.</strong></p> : null}
          </>}
          confirmLabel="Reset identity and change name"
          busyLabel="Resetting identity…"
          busy={changeNameBusy}
          returnFocusTo={changeNameTrigger.current}
          onConfirm={() => { changeName(); navigateImprovements(null); }}
          onCancel={() => setChangeNameOpen(false)}
        /> : null}

        {clientError || room.error ? <div className="error-strip" role="alert"><span>{clientError || room.error}</span>{clientError ? <button type="button" aria-label="Dismiss error" onClick={() => setClientError("")}>×</button> : null}</div> : null}
        <footer className="status-bar">
          <div className="status-cell"><span className="people-icon" aria-hidden="true">♟♟♟♟♟</span> {peopleHere} here</div>
          <div className="status-cell">{statusText}</div>
          <div className="status-cell status-cell--connection"><span className="connection-lights"><i /><i /><i /></span> {connected ? "Connected" : "Reconnecting..."}</div>
        </footer>
      </section>
    </main>
  );
}

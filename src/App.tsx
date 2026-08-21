import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { joinRoom, loadRoom, runAction, sendMessage, updateMyStyle, updateSettings } from "./api";
import { AgentSettingsDialog, ChatComposer, RoomControls, RoomRoster, Transcript, TranscriptHeader } from "./components";
import { scrollTranscriptToEnd } from "./scroll";
import { appendOptimisticHumanMessage, discardOptimisticMessage } from "./optimistic-message";
import { adjacentTranscriptMagnification, loadTranscriptMagnification, saveTranscriptMagnification } from "./transcript-view";
import { DEFAULT_PARTICIPANT_STYLES, sanitizeChatStyle, type ChatStyle } from "../shared/chat-style";
import type { ConversationEnergy } from "../shared/conversation-energy";
import { AGENT_IDS, agentScreenName } from "../shared/participants";
import type { AgentId, HumanPresence, RoomState, WritableAgent } from "./types";

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
          <div className="window-buttons" aria-hidden="true"><span>_</span><span>□</span><span>×</span></div>
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
          <div className="window-buttons" aria-hidden="true"><span>_</span><span>□</span><span>×</span></div>
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
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"people" | "room" | null>(null);
  const [configuredAgent, setConfiguredAgent] = useState<AgentId | null>(null);
  const [clientError, setClientError] = useState("");
  const [hasInitialState, setHasInitialState] = useState(false);
  const [minimumLoadingComplete, setMinimumLoadingComplete] = useState(false);
  const [savedHuman, setSavedHuman] = useState(loadHumanProfile);
  const [human, setHuman] = useState<HumanPresence | null>(null);
  const [joinError, setJoinError] = useState("");
  const [transcriptMagnification, setTranscriptMagnification] = useState(loadTranscriptMagnification);
  const transcript = useRef<HTMLDivElement>(null);
  const receivedLiveState = useRef(false);
  const roomRevealed = useRef(false);

  useEffect(() => {
    if (!savedHuman) return;
    let cancelled = false;
    void joinRoom(savedHuman).then((joined) => {
      if (cancelled) return;
      setHuman(joined);
      saveHumanProfile(joined);
      setJoinError("");
    }).catch((error: Error) => {
      if (!cancelled) setJoinError(error.message);
    });
    return () => { cancelled = true; };
  }, [savedHuman?.id, savedHuman?.name]);

  useEffect(() => {
    if (!human) return;
    receivedLiveState.current = false;
    setHasInitialState(false);
    void loadRoom().then((next) => {
      setRoom((current) => receivedLiveState.current
        ? { ...current, availability: next.availability || current.availability }
        : next);
      setHasInitialState(true);
    }).catch((error: Error) => setClientError(error.message));
    const events = new EventSource(`/api/events?humanId=${encodeURIComponent(human.id)}`);
    events.onmessage = (event) => {
      const next = JSON.parse(event.data) as RoomState;
      receivedLiveState.current = true;
      setRoom((current) => ({ ...next, availability: current.availability }));
      setHasInitialState(true);
      setClientError("");
    };
    events.onopen = () => setClientError("");
    events.onerror = () => setClientError("The local room server disconnected. Retrying...");
    return () => events.close();
  }, [human?.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => setMinimumLoadingComplete(true), MINIMUM_LOADING_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!configuredAgent && !mobilePanel) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setConfiguredAgent(null);
      setMobilePanel(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [configuredAgent, mobilePanel]);

  const ready = hasInitialState && minimumLoadingComplete;

  useLayoutEffect(() => {
    if (!ready) return;
    scrollTranscriptToEnd(transcript.current, roomRevealed.current ? "smooth" : "auto");
    roomRevealed.current = true;
  }, [ready, room.messages.length]);

  const working = room.status === "working";

  async function withErrorHandling(action: () => Promise<unknown>) {
    try {
      setClientError("");
      await action();
    } catch (error) {
      setClientError(error instanceof Error ? error.message : String(error));
    }
  }

  function changeWritable(agent: WritableAgent) {
    setRoom((current) => ({ ...current, settings: { ...current.settings, writableAgent: agent } }));
    void withErrorHandling(() => updateSettings({ writableAgent: agent }));
  }

  function changeConversationEnergy(conversationEnergy: ConversationEnergy) {
    setRoom((current) => ({ ...current, settings: { ...current.settings, conversationEnergy } }));
    void withErrorHandling(() => updateSettings({ conversationEnergy }));
  }

  function changeTopic(topic: string) {
    const nextTopic = topic.trim() || "Open conversation";
    if (nextTopic === room.settings.topic) return;
    setRoom((current) => ({
      ...current,
      settings: { ...current.settings, topic: nextTopic },
    }));
    void withErrorHandling(() => updateSettings({ topic: nextTopic }));
  }

  function changeRoomName(roomName: string) {
    const nextRoomName = roomName.trim() || "The Agent Room";
    if (nextRoomName === room.settings.roomName) return;
    setRoom((current) => ({ ...current, settings: { ...current.settings, roomName: nextRoomName } }));
    void withErrorHandling(() => updateSettings({ roomName: nextRoomName }));
  }

  function changeMyStyle(style: ChatStyle) {
    if (!human) return;
    const nextHuman = { ...human, style: sanitizeChatStyle(style, human.style) };
    setHuman(nextHuman);
    setSavedHuman(nextHuman);
    saveHumanProfile(nextHuman);
    void withErrorHandling(() => updateMyStyle(human.id, nextHuman.style));
  }

  function changeTranscriptMagnification(direction: -1 | 1) {
    setTranscriptMagnification((current) => {
      const next = adjacentTranscriptMagnification(current, direction);
      saveTranscriptMagnification(next);
      return next;
    });
  }

  function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || !human) return;
    const optimisticId = `pending-${crypto.randomUUID()}`;
    setDraft("");
    setRoom((current) => appendOptimisticHumanMessage(current, human, optimisticId, message, new Date().toISOString()));
    void (async () => {
      try {
        setClientError("");
        const next = await sendMessage(human.id, message);
        setRoom((current) => {
          const stillPending = current.messages.some(({ id }) => id === optimisticId);
          if (!stillPending && current.messages.length >= next.messages.length) return current;
          return { ...next, availability: current.availability };
        });
      } catch (error) {
        setRoom((current) => discardOptimisticMessage(current, optimisticId));
        setDraft((current) => current || message);
        setClientError(error instanceof Error ? error.message : String(error));
      }
    })();
  }

  function invoke(action: "ask" | "review" | "roundtable" | "continue", agent: AgentId | "all") {
    setMenuOpen(false);
    void withErrorHandling(() => runAction(action, agent));
  }

  function joinWithName(name: string) {
    setJoinError("");
    const profile = { id: crypto.randomUUID(), name, style: DEFAULT_PARTICIPANT_STYLES.you };
    setSavedHuman(profile);
  }

  function changeName() {
    setHuman(null);
    setSavedHuman(null);
    saveHumanProfile(null);
    setRoom(EMPTY_ROOM);
    setHasInitialState(false);
  }

  const statusText = working
    ? room.activeAgent
      ? `${agentScreenName(room.activeAgent)} is typing...`
      : "Agents are typing..."
    : room.status === "error"
      ? "Room needs attention"
      : "Room is idle";
  const peopleHere = (room.humans?.length || 0) + AGENT_IDS.filter((agent) => room.availability?.[agent] !== false).length;

  useEffect(() => {
    document.title = `AllMyFriendsAreAgents — ${room.settings.roomName}`;
  }, [room.settings.roomName]);

  if (!savedHuman) return <NameEntry error={joinError} onJoin={joinWithName} />;
  if (!human) return <LoadingScreen error={joinError || "Joining the room"} />;
  if (!ready) return <LoadingScreen error={clientError} />;

  return (
    <main className="desktop">
      <section className="app-window" aria-label="AllMyFriendsAreAgents application">
        <header className="window-titlebar">
          <span className="app-icon" aria-hidden="true">AW</span>
          <h1><span className="title-long">AllMyFriendsAreAgents — </span>{room.settings.roomName}</h1>
          <div className="window-buttons" aria-hidden="true"><span>_</span><span>□</span><span>×</span></div>
        </header>
        <nav className="menu-bar" aria-label="Application menu">
          <button
            type="button"
            aria-controls="room-side-panel"
            aria-expanded={mobilePanel === "room"}
            onClick={() => setMobilePanel((panel) => panel === "room" ? null : "room")}
          >Room</button>
          <button
            type="button"
            aria-controls="room-side-panel"
            aria-expanded={mobilePanel === "people"}
            onClick={() => setMobilePanel((panel) => panel === "people" ? null : "people")}
          >People</button>
          <button type="button" onClick={changeName}>Change name</button>
          <div className="menu-wrap">
            <button type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>Actions</button>
            {menuOpen ? (
              <div className="dropdown-menu">
                <button type="button" disabled={working} onClick={() => invoke("continue", "all")}>Continue discussion</button>
                <button type="button" disabled={working} onClick={() => invoke("roundtable", "all")}>Start roundtable</button>
                <button type="button" disabled={working} onClick={() => invoke("review", "all")}>Review with all agents</button>
              </div>
            ) : null}
          </div>
          <button type="button" title="Agent project permissions are available from the gear beside each agent. Reviews are always read-only.">Help</button>
        </nav>

        <div className="workspace">
          <section className="chat-panel beveled-inset">
            <TranscriptHeader roomName={room.settings.roomName} magnification={transcriptMagnification} onMagnificationChange={changeTranscriptMagnification} />
            <Transcript messages={room.messages} magnification={transcriptMagnification} transcriptRef={transcript} />
            <ChatComposer
              draft={draft}
              style={human.style}
              onDraftChange={setDraft}
              onStyleChange={changeMyStyle}
              onSubmit={submitMessage}
            />
          </section>
          {mobilePanel ? (
            <button
              type="button"
              className="mobile-panel-backdrop"
              aria-label="Close side panel"
              onClick={() => setMobilePanel(null)}
            />
          ) : null}
          <div
            id="room-side-panel"
            className={`right-rail${mobilePanel ? " right-rail--open" : ""}`}
            data-mobile-panel={mobilePanel || undefined}
          >
            <header className="mobile-panel-header">
              <strong>{mobilePanel === "people" ? "People in this room" : "Room settings"}</strong>
              <button type="button" aria-label="Close side panel" onClick={() => setMobilePanel(null)}>×</button>
            </header>
            <RoomRoster availability={room.availability} humans={room.humans || []} currentHumanId={human.id} onConfigureAgent={setConfiguredAgent} />
            <RoomControls
              roomName={room.settings.roomName}
              topic={room.settings.topic}
              conversationEnergy={room.settings.conversationEnergy}
              disabled={working}
              onRoomNameChange={changeRoomName}
              onTopicChange={changeTopic}
              onConversationEnergyChange={changeConversationEnergy}
            />
          </div>
        </div>

        {configuredAgent ? (
          <AgentSettingsDialog
            agent={configuredAgent}
            available={room.availability?.[configuredAgent] !== false}
            writableAgent={room.settings.writableAgent}
            disabled={working}
            onWritableChange={changeWritable}
            onClose={() => setConfiguredAgent(null)}
          />
        ) : null}

        {clientError || room.error ? <div className="error-strip" role="alert">{clientError || room.error}</div> : null}
        <footer className="status-bar">
          <div className="status-cell"><span className="people-icon" aria-hidden="true">♟♟♟♟♟</span> {peopleHere} here</div>
          <div className="status-cell">{statusText}</div>
          <div className="status-cell status-cell--connection"><span className="connection-lights"><i /><i /><i /></span> Connected</div>
        </footer>
      </section>
    </main>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadRoom, runAction, sendMessage, updateMyStyle, updateSettings } from "./api";
import { BuddyList, ChatComposer, RoomControls, Transcript, TranscriptHeader } from "./components";
import { scrollTranscriptToEnd } from "./scroll";
import { appendOptimisticHumanMessage, discardOptimisticMessage } from "./optimistic-message";
import { adjacentTranscriptMagnification, loadTranscriptMagnification, saveTranscriptMagnification } from "./transcript-view";
import { DEFAULT_PARTICIPANT_STYLES, sanitizeChatStyle, type ChatStyle } from "../shared/chat-style";
import type { ConversationEnergy } from "../shared/conversation-energy";
import { agentScreenName } from "../shared/participants";
import type { AgentId, RoomState, WritableAgent } from "./types";

const EMPTY_ROOM: RoomState = {
  messages: [],
  sessions: {},
  settings: {
    topic: "Open conversation",
    writableAgent: "nobody",
    reviewMode: "read-only",
    conversationEnergy: "balanced",
    projectPath: "",
    participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
  },
  status: "idle",
};
const MINIMUM_LOADING_MS = 450;

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

export default function App() {
  const [room, setRoom] = useState<RoomState>(EMPTY_ROOM);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [clientError, setClientError] = useState("");
  const [hasInitialState, setHasInitialState] = useState(false);
  const [minimumLoadingComplete, setMinimumLoadingComplete] = useState(false);
  const [transcriptMagnification, setTranscriptMagnification] = useState(loadTranscriptMagnification);
  const transcript = useRef<HTMLDivElement>(null);
  const receivedLiveState = useRef(false);
  const roomRevealed = useRef(false);

  useEffect(() => {
    void loadRoom().then((next) => {
      setRoom((current) => receivedLiveState.current
        ? { ...current, availability: next.availability || current.availability }
        : next);
      setHasInitialState(true);
    }).catch((error: Error) => setClientError(error.message));
    const events = new EventSource("/api/events");
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
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setMinimumLoadingComplete(true), MINIMUM_LOADING_MS);
    return () => window.clearTimeout(timer);
  }, []);

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
      sessions: {},
      settings: { ...current.settings, topic: nextTopic },
    }));
    void withErrorHandling(() => updateSettings({ topic: nextTopic }));
  }

  function changeMyStyle(style: ChatStyle) {
    const nextStyle = sanitizeChatStyle(style, room.settings.participantStyles.you);
    setRoom((current) => ({
      ...current,
      settings: {
        ...current.settings,
        participantStyles: { ...current.settings.participantStyles, you: nextStyle },
      },
    }));
    void withErrorHandling(() => updateMyStyle(nextStyle));
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
    if (!message) return;
    const optimisticId = `pending-${crypto.randomUUID()}`;
    setDraft("");
    setRoom((current) => appendOptimisticHumanMessage(current, optimisticId, message, new Date().toISOString()));
    void (async () => {
      try {
        setClientError("");
        const next = await sendMessage(message);
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

  function invoke(action: "ask" | "review" | "roundtable", agent: AgentId | "all") {
    setMenuOpen(false);
    void withErrorHandling(() => runAction(action, agent));
  }

  const statusText = working
    ? room.activeAgent
      ? `${agentScreenName(room.activeAgent)} is typing...`
      : "Agents are typing..."
    : room.status === "error"
      ? "Room needs attention"
      : "Room is idle";

  if (!ready) return <LoadingScreen error={clientError} />;

  return (
    <main className="desktop">
      <section className="app-window" aria-label="AllMyFriendsAreAgents application">
        <header className="window-titlebar">
          <span className="app-icon" aria-hidden="true">AW</span>
          <h1>AllMyFriendsAreAgents — The Agent Room</h1>
          <div className="window-buttons" aria-hidden="true"><span>_</span><span>□</span><span>×</span></div>
        </header>
        <nav className="menu-bar" aria-label="Application menu">
          <button type="button">Room</button>
          <button type="button">People</button>
          <div className="menu-wrap">
            <button type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>Actions</button>
            {menuOpen ? (
              <div className="dropdown-menu">
                <button type="button" disabled={working} onClick={() => invoke("roundtable", "all")}>Start roundtable</button>
                <button type="button" disabled={working} onClick={() => invoke("review", "all")}>Review with all agents</button>
              </div>
            ) : null}
          </div>
          <button type="button" title="Ordinary chat can use the selected writable agent. Explicit reviews are always read-only.">Help</button>
        </nav>

        <div className="workspace">
          <section className="chat-panel beveled-inset">
            <TranscriptHeader magnification={transcriptMagnification} onMagnificationChange={changeTranscriptMagnification} />
            <Transcript messages={room.messages} magnification={transcriptMagnification} transcriptRef={transcript} />
            <ChatComposer
              draft={draft}
              style={room.settings.participantStyles.you}
              onDraftChange={setDraft}
              onStyleChange={changeMyStyle}
              onSubmit={submitMessage}
            />
          </section>
          <div className="right-rail">
            <BuddyList availability={room.availability} />
            <RoomControls
              topic={room.settings.topic}
              writableAgent={room.settings.writableAgent}
              conversationEnergy={room.settings.conversationEnergy}
              disabled={working}
              onTopicChange={changeTopic}
              onWritableChange={changeWritable}
              onConversationEnergyChange={changeConversationEnergy}
            />
          </div>
        </div>

        {clientError || room.error ? <div className="error-strip" role="alert">{clientError || room.error}</div> : null}
        <footer className="status-bar">
          <div className="status-cell"><span className="people-icon" aria-hidden="true">♟♟♟♟♟</span> 5 participants</div>
          <div className="status-cell">{statusText}</div>
          <div className="status-cell status-cell--connection"><span className="connection-lights"><i /><i /><i /></span> Connected</div>
        </footer>
      </section>
    </main>
  );
}

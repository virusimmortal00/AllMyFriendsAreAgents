import { useEffect, useRef, useState } from "react";
import { loadRoom, runAction, sendMessage, updateMyStyle, updateSettings } from "./api";
import { BuddyList, ChatComposer, PanelTitle, RoomControls, Transcript } from "./components";
import { scrollTranscriptToEnd } from "./scroll";
import { DEFAULT_PARTICIPANT_STYLES, sanitizeChatStyle, type ChatStyle } from "../shared/chat-style";
import type { AgentId, RoomState, WritableAgent } from "./types";

const EMPTY_ROOM: RoomState = {
  messages: [],
  sessions: {},
  settings: {
    topic: "Open conversation",
    writableAgent: "nobody",
    reviewMode: "read-only",
    maxRounds: 3,
    projectPath: "",
    participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
  },
  status: "idle",
};

export default function App() {
  const [room, setRoom] = useState<RoomState>(EMPTY_ROOM);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [clientError, setClientError] = useState("");
  const transcript = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadRoom().then(setRoom).catch((error: Error) => setClientError(error.message));
    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      const next = JSON.parse(event.data) as RoomState;
      setRoom((current) => ({ ...next, availability: current.availability }));
      setClientError("");
    };
    events.onerror = () => setClientError("The local room server disconnected. Retrying...");
    return () => events.close();
  }, []);

  useEffect(() => {
    scrollTranscriptToEnd(transcript.current);
  }, [room.messages.length]);

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

  function changeRounds(rounds: number) {
    setRoom((current) => ({ ...current, settings: { ...current.settings, maxRounds: rounds } }));
    void withErrorHandling(() => updateSettings({ maxRounds: rounds }));
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

  function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || working) return;
    setDraft("");
    void withErrorHandling(() => sendMessage(message));
  }

  function invoke(action: "ask" | "review" | "roundtable", agent: AgentId | "both") {
    setMenuOpen(false);
    void withErrorHandling(() => runAction(action, agent));
  }

  const statusText = working
    ? room.activeAgent
      ? `${room.activeAgent === "codex" ? "Codex" : "Claude"} is typing...`
      : "Agents are typing..."
    : room.status === "error"
      ? "Room needs attention"
      : "Room is idle";

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
                <button type="button" disabled={working} onClick={() => invoke("roundtable", "both")}>Start roundtable</button>
                <button type="button" disabled={working} onClick={() => invoke("review", "both")}>Review with both agents</button>
              </div>
            ) : null}
          </div>
          <button type="button" title="Ordinary chat can use the selected writable agent. Explicit reviews are always read-only.">Help</button>
        </nav>

        <div className="workspace">
          <section className="chat-panel beveled-inset">
            <PanelTitle>The Agent Room</PanelTitle>
            <Transcript messages={room.messages} participantStyles={room.settings.participantStyles} transcriptRef={transcript} />
            <ChatComposer
              draft={draft}
              style={room.settings.participantStyles.you}
              disabled={working}
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
              maxRounds={room.settings.maxRounds}
              disabled={working}
              onTopicChange={changeTopic}
              onWritableChange={changeWritable}
              onRoundsChange={changeRounds}
            />
          </div>
        </div>

        {clientError || room.error ? <div className="error-strip" role="alert">{clientError || room.error}</div> : null}
        <footer className="status-bar">
          <div className="status-cell"><span className="people-icon" aria-hidden="true">♟♟♟</span> 3 participants</div>
          <div className="status-cell">{statusText}</div>
          <div className="status-cell status-cell--connection"><span className="connection-lights"><i /><i /><i /></span> Connected</div>
        </footer>
      </section>
    </main>
  );
}

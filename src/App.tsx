import { useEffect, useRef, useState } from "react";
import { loadRoom, runAction, sendMessage, updateSettings } from "./api";
import { BuddyList, PanelTitle, RoomControls, Transcript } from "./components";
import type { AgentId, RoomState, WritableAgent } from "./types";

const EMPTY_ROOM: RoomState = {
  messages: [],
  sessions: {},
  settings: {
    writableAgent: "nobody",
    reviewMode: "read-only",
    maxRounds: 3,
    projectPath: "",
  },
  status: "idle",
};

export default function App() {
  const [room, setRoom] = useState<RoomState>(EMPTY_ROOM);
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState<AgentId | "both">("both");
  const [menuOpen, setMenuOpen] = useState(false);
  const [clientError, setClientError] = useState("");
  const transcriptEnd = useRef<HTMLDivElement>(null);

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

  useEffect(() => transcriptEnd.current?.scrollIntoView({ behavior: "smooth" }), [room.messages.length]);

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

  function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || working) return;
    setDraft("");
    void withErrorHandling(() => sendMessage(message, target));
  }

  function invoke(action: "ask" | "review" | "roundtable", agent: AgentId | "both") {
    setMenuOpen(false);
    void withErrorHandling(() => runAction(action, agent));
  }

  const statusText = working
    ? `${room.activeAgent === "codex" ? "Codex" : "Claude"} is typing...`
    : room.status === "error"
      ? "Room needs attention"
      : "Room is idle";

  return (
    <main className="desktop">
      <section className="app-window" aria-label="AgentWire 98 application">
        <header className="window-titlebar">
          <span className="app-icon" aria-hidden="true">AW</span>
          <h1>AgentWire 98 — The Agent Room</h1>
          <div className="window-buttons" aria-hidden="true"><span>_</span><span>□</span><span>×</span></div>
        </header>
        <nav className="menu-bar" aria-label="Application menu">
          <button type="button">Room</button>
          <button type="button">People</button>
          <div className="menu-wrap">
            <button type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>Actions</button>
            {menuOpen ? (
              <div className="dropdown-menu">
                <button type="button" disabled={working} onClick={() => invoke("roundtable", "both")}>Start roundtable ({room.settings.maxRounds} turns)</button>
                <button type="button" disabled={working} onClick={() => invoke("review", "both")}>Review with both agents</button>
              </div>
            ) : null}
          </div>
          <button type="button" title="AgentWire keeps reviews read-only unless you choose a writable agent.">Help</button>
        </nav>

        <div className="workspace">
          <BuddyList availability={room.availability} />
          <section className="chat-panel beveled-inset">
            <PanelTitle>The Agent Room</PanelTitle>
            <Transcript messages={room.messages} />
            <div ref={transcriptEnd} />
            <form className="composer" onSubmit={submitMessage}>
              <label htmlFor="recipient">To:</label>
              <select id="recipient" className="classic-select" value={target} onChange={(event) => setTarget(event.target.value as AgentId | "both")}>
                <option value="both">Everyone</option>
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
              </select>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Type your message here..."
                aria-label="Message"
                disabled={working}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <button className="classic-button send-button" type="submit" disabled={working || !draft.trim()}>Send</button>
            </form>
          </section>
          <RoomControls
            writableAgent={room.settings.writableAgent}
            maxRounds={room.settings.maxRounds}
            disabled={working}
            onWritableChange={changeWritable}
            onRoundsChange={changeRounds}
            onAsk={(agent) => invoke("ask", agent)}
            onReview={() => invoke("review", "both")}
          />
        </div>

        {clientError || room.error ? <div className="error-strip" role="alert">{clientError || room.error}</div> : null}
        <footer className="status-bar">
          <div className="status-cell"><span className="people-icon" aria-hidden="true">♟♟♟</span> 3 people online</div>
          <div className="status-cell">{statusText}</div>
          <div className="status-cell status-cell--connection"><span className="connection-lights"><i /><i /><i /></span> Connected</div>
        </footer>
      </section>
    </main>
  );
}


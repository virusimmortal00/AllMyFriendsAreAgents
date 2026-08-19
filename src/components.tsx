import type { AgentId, RoomMessage, WritableAgent } from "./types";

const buddyLabels = {
  codex: "Codex",
  claude: "Claude",
  you: "You",
} as const;

export function PixelBuddy({ buddy, small = false }: { buddy: "codex" | "claude" | "you"; small?: boolean }) {
  return (
    <span className={`pixel-buddy pixel-buddy--${buddy} ${small ? "pixel-buddy--small" : ""}`} aria-hidden="true">
      <span className="pixel-buddy__antenna" />
      <span className="pixel-buddy__face">
        <span className="pixel-buddy__eyes" />
        <span className="pixel-buddy__mouth" />
      </span>
      <span className="pixel-buddy__body" />
    </span>
  );
}

export function PanelTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="panel-title">{children}</h2>;
}

export function BuddyList({ availability }: { availability?: Record<AgentId, boolean> }) {
  return (
    <aside className="buddy-panel beveled-inset" aria-label="Buddy list">
      <PanelTitle>Buddy List</PanelTitle>
      <div className="buddy-list">
        {(["codex", "claude", "you"] as const).map((buddy) => {
          const online = buddy === "you" || availability?.[buddy] !== false;
          return (
            <div className="buddy-row" key={buddy}>
              <PixelBuddy buddy={buddy} />
              <div>
                <strong className={`speaker speaker--${buddy}`}>{buddyLabels[buddy]}</strong>
                <span>{online ? "Online" : "Offline"}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="panel-title panel-title--section">Rooms</div>
      <nav className="rooms-list" aria-label="Rooms">
        <button className="room-row room-row--active" type="button">
          <span className="room-icon">•••</span> The Agent Room
        </button>
        <button className="room-row" type="button" disabled title="Multiple rooms are coming soon">
          <span className="new-room-icon">+</span> New room...
        </button>
      </nav>
    </aside>
  );
}

function formatTime(timestamp: string) {
  return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

export function Transcript({ messages }: { messages: RoomMessage[] }) {
  return (
    <div className="transcript beveled-inset" role="log" aria-live="polite" aria-label="Room transcript">
      {messages.map((message) => (
        <article className={`message message--${message.kind || "chat"}`} key={message.id}>
          <time>[{formatTime(message.timestamp)}]</time>
          <div>
            <strong className={`speaker speaker--${message.speaker}`}>{buddyLabels[message.speaker as keyof typeof buddyLabels] || "System"}:</strong>{" "}
            <span className="message__text">{message.text}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

interface RoomControlsProps {
  writableAgent: WritableAgent;
  maxRounds: number;
  disabled: boolean;
  onWritableChange: (agent: WritableAgent) => void;
  onRoundsChange: (rounds: number) => void;
  onAsk: (agent: AgentId | "both") => void;
  onReview: () => void;
}

export function RoomControls({
  writableAgent,
  maxRounds,
  disabled,
  onWritableChange,
  onRoundsChange,
  onAsk,
  onReview,
}: RoomControlsProps) {
  return (
    <aside className="controls-panel beveled-inset" aria-label="Room controls">
      <PanelTitle>Room Controls</PanelTitle>
      <fieldset>
        <legend>Writable agent:</legend>
        {(["codex", "claude", "nobody"] as const).map((agent) => (
          <label className="radio-row" key={agent}>
            <input
              type="radio"
              name="writable-agent"
              value={agent}
              checked={writableAgent === agent}
              onChange={() => onWritableChange(agent)}
              disabled={disabled}
            />
            <span className={`speaker speaker--${agent}`}>{agent === "nobody" ? "Nobody" : buddyLabels[agent]}</span>
          </label>
        ))}
      </fieldset>
      <hr />
      <label className="field-label" htmlFor="review-mode">Review mode:</label>
      <select id="review-mode" value="read-only" disabled className="classic-select">
        <option value="read-only">Read only</option>
      </select>
      <label className="field-label" htmlFor="max-rounds">Maximum rounds:</label>
      <input
        id="max-rounds"
        className="classic-input"
        type="number"
        min={1}
        max={8}
        value={maxRounds}
        disabled={disabled}
        onChange={(event) => onRoundsChange(Math.min(8, Math.max(1, Number(event.target.value))))}
      />
      <div className="agent-actions">
        <button className="classic-button" type="button" disabled={disabled} onClick={() => onAsk("codex")}>
          <PixelBuddy buddy="codex" small /> Ask Codex
        </button>
        <button className="classic-button" type="button" disabled={disabled} onClick={() => onAsk("claude")}>
          <PixelBuddy buddy="claude" small /> Ask Claude
        </button>
        <button className="classic-button" type="button" disabled={disabled} onClick={() => onAsk("both")}>
          <span className="duo-icon"><PixelBuddy buddy="you" small /><PixelBuddy buddy="codex" small /></span> Ask Both
        </button>
      </div>
      <hr />
      <button className="classic-button review-button" type="button" disabled={disabled} onClick={onReview}>
        <span className="review-icon">✓</span> Review Changes
      </button>
    </aside>
  );
}


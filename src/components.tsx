import { useRef, useState, type CSSProperties, type FormEvent, type RefObject } from "react";
import {
  AIM_5_BASIC_COLORS,
  AIM_5_CUSTOM_COLORS,
  CHAT_FONT_FAMILIES,
  type ChatStyle,
  type ParticipantStyles,
  type StyledParticipant,
} from "../shared/chat-style";
import { visibleAgentText } from "../shared/message-format";
import { AIM_SMILEYS, renderAimSmileys } from "./aim-smileys";
import type { AgentId, RoomMessage, WritableAgent } from "./types";

const buddyLabels = {
  codex: "Codex",
  claude: "Claude",
  you: "You",
} as const;

function chatStyleProperties(style: ChatStyle): CSSProperties {
  return {
    fontFamily: `"${style.fontFamily}", sans-serif`,
    fontSize: `${style.fontSize}px`,
    color: style.textColor,
    backgroundColor: style.backgroundColor,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? "italic" : "normal",
    textDecoration: style.underline ? "underline" : "none",
  };
}

export function PixelBuddy({ buddy }: { buddy: "codex" | "claude" | "you" }) {
  return (
    <span className={`pixel-buddy pixel-buddy--${buddy}`} aria-hidden="true">
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
          const available = buddy === "you" || availability?.[buddy] !== false;
          return (
            <div className="buddy-row" key={buddy}>
              <PixelBuddy buddy={buddy} />
              <div>
                <strong className={`speaker speaker--${buddy}`}>{buddyLabels[buddy]}</strong>
                <span>{buddy === "you" ? "Present" : available ? "CLI installed" : "CLI missing"}</span>
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

export function Transcript({
  messages,
  participantStyles,
  transcriptRef,
}: {
  messages: RoomMessage[];
  participantStyles: ParticipantStyles;
  transcriptRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={transcriptRef} className="transcript beveled-inset" role="log" aria-live="polite" aria-label="Room transcript">
      {messages.map((message) => {
        const participant = (["you", "codex", "claude"] as const).includes(message.speaker as StyledParticipant)
          ? message.speaker as StyledParticipant
          : undefined;
        const messageStyle = message.style || (participant ? participantStyles[participant] : undefined);
        return (
          <article className={`message message--${message.kind || "chat"}`} key={message.id}>
            <time>[{formatTime(message.timestamp)}]</time>
            <div>
              <strong className={`speaker speaker--${message.speaker}`}>{buddyLabels[message.speaker as keyof typeof buddyLabels] || "System"}:</strong>{" "}
              <span className="message__bubble" style={messageStyle ? chatStyleProperties(messageStyle) : undefined}>
                <span className="message__text">{renderAimSmileys(visibleAgentText(message.text))}</span>
              </span>
            </div>
          </article>
        );
      })}
    </div>
  );
}

interface ChatComposerProps {
  draft: string;
  style: ChatStyle;
  disabled: boolean;
  onDraftChange: (draft: string) => void;
  onStyleChange: (style: ChatStyle) => void;
  onSubmit: (event: FormEvent) => void;
}

export function ChatComposer({ draft, style, disabled, onDraftChange, onStyleChange, onSubmit }: ChatComposerProps) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [colorPicker, setColorPicker] = useState<"text" | "background" | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  function updateStyle(update: Partial<ChatStyle>) {
    onStyleChange({ ...style, ...update });
  }

  function insertSmiley(shortcut: string) {
    const input = textarea.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    onDraftChange(`${draft.slice(0, start)}${shortcut}${draft.slice(end)}`);
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
          disabled={disabled}
          onChange={(event) => updateStyle({ fontFamily: event.target.value as ChatStyle["fontFamily"] })}
        >
          {CHAT_FONT_FAMILIES.map((font) => <option value={font} key={font}>{font}</option>)}
        </select>
        <button type="button" aria-label="Decrease text size" title="Smaller text" disabled={disabled || style.fontSize <= 12} onClick={() => updateStyle({ fontSize: style.fontSize - 1 })}>A−</button>
        <span className="font-size-readout" aria-label={`Text size ${style.fontSize}`}>{style.fontSize}</span>
        <button type="button" aria-label="Increase text size" title="Larger text" disabled={disabled || style.fontSize >= 28} onClick={() => updateStyle({ fontSize: style.fontSize + 1 })}>A+</button>
        <button type="button" className="format-bold" aria-label="Bold" aria-pressed={style.bold} disabled={disabled} onClick={() => updateStyle({ bold: !style.bold })}>B</button>
        <button type="button" className="format-italic" aria-label="Italic" aria-pressed={style.italic} disabled={disabled} onClick={() => updateStyle({ italic: !style.italic })}>I</button>
        <button type="button" className="format-underline" aria-label="Underline" aria-pressed={style.underline} disabled={disabled} onClick={() => updateStyle({ underline: !style.underline })}>U</button>
        <button
          type="button"
          className="color-well color-well--text"
          title="Text color"
          aria-label="Text color"
          aria-expanded={colorPicker === "text"}
          disabled={disabled}
          onClick={() => setColorPicker((current) => current === "text" ? null : "text")}
        >
          <span aria-hidden="true">A</span>
          <i aria-hidden="true" style={{ backgroundColor: style.textColor }} />
        </button>
        <button
          type="button"
          className="color-well color-well--background"
          title="Background color"
          aria-label="Background color"
          aria-expanded={colorPicker === "background"}
          disabled={disabled}
          onClick={() => setColorPicker((current) => current === "background" ? null : "background")}
        >
          <span aria-hidden="true">▧</span>
          <i aria-hidden="true" style={{ backgroundColor: style.backgroundColor }} />
        </button>
        {colorPicker ? (
          <div className="aim-color-picker" aria-label={`${colorPicker === "text" ? "Text" : "Background"} color palette`}>
            <strong>{colorPicker === "text" ? "Text" : "Background"} color</strong>
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
        <div className="emoji-control">
          <button type="button" aria-label="Classic emojis" aria-expanded={emojiOpen} disabled={disabled} onClick={() => setEmojiOpen((open) => !open)}>☺</button>
          {emojiOpen ? (
            <div className="emoji-picker" aria-label="Classic AIM smiley picker">
              {AIM_SMILEYS.map((smiley) => (
                <button type="button" key={smiley.name} aria-label={`Insert ${smiley.name} ${smiley.shortcut}`} title={`${smiley.name} (${smiley.shortcut})`} onClick={() => insertSmiley(smiley.shortcut)}>
                  <img src={smiley.src} alt="" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <textarea
        ref={textarea}
        value={draft}
        style={chatStyleProperties(style)}
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder="Message everyone in this room..."
        aria-label="Message"
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <button className="classic-button send-button" type="submit" disabled={disabled || !draft.trim()}>Send</button>
    </form>
  );
}

interface RoomControlsProps {
  writableAgent: WritableAgent;
  maxRounds: number;
  disabled: boolean;
  onWritableChange: (agent: WritableAgent) => void;
  onRoundsChange: (rounds: number) => void;
}

export function RoomControls({
  writableAgent,
  maxRounds,
  disabled,
  onWritableChange,
  onRoundsChange,
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
    </aside>
  );
}

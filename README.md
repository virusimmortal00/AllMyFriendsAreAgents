# AgentWire 98

A local, chatroom-style collaboration surface for you, Codex, and Claude Code.

The app uses the installed `codex` and `claude` CLIs, keeps one resumable session per agent, and stores the room transcript locally. Reviews are read-only by default and automated roundtables have a hard turn limit.

## Development

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:4173>. The API runs on `127.0.0.1:4174`.

## Safety model

- The room binds to localhost only.
- Review mode is read-only unless you explicitly choose a writable agent.
- Only one agent can be writable at a time.
- Agent-to-agent exchanges stop at the configured maximum round count.
- Runtime transcripts and session IDs live under `.agentwire/`, which is ignored by Git.

## Design reference

The implementation follows [`docs/design/agentwire-98-concept.png`](docs/design/agentwire-98-concept.png), an original late-1990s chat-client-inspired design.


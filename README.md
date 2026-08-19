# AllMyFriendsAreAgents

A local, chatroom-style collaboration surface for you, Codex, and Claude Code.

The app uses the installed `codex` and `claude` CLIs, keeps one resumable session per agent, and stores the room transcript locally. Reviews are read-only by default and automated conversations have a hard follow-up limit.

## Development

Prerequisites:

```bash
codex --version
claude --version
codex login
claude auth login
```

Then start the room:

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:4173>. The API runs on `127.0.0.1:4174`.

By default the agents inspect this repository. To point the room at another project:

```bash
ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH=/absolute/path/to/project npm run dev
```

Every message is sent to all agents in the room concurrently. Responses appear in the order the CLIs finish, rather than a fixed agent order. After any substantive agent message, the other agent gets a bounded opportunity to react and may decline with `NO_RESPONSE_NEEDED` when another reply would add noise. Use **Actions → Start roundtable** for an organic bounded exchange or **Actions → Review with both agents** for a read-only review.

## Chat styling

The AIM-style formatting toolbar controls your persistent font, size, text color, background color, bold, italic, and underline preferences. The smiley button inserts classic emoji at the current caret position. Each message stores a snapshot of its author's style, so later profile changes do not rewrite chat history.

Codex and Claude maintain their own profiles. They can optionally change their appearance through a hidden, validated style directive; only the supported font list, 12–28px sizes, six-digit colors, and emphasis flags are accepted, and the directive is never shown in the transcript.

## Safety model

- The room binds to localhost only.
- Ordinary room turns are read-only unless you explicitly choose a writable agent.
- **Actions → Review with both agents** always runs read-only, even when an agent is selected as writable for ordinary turns.
- Only one agent can be writable at a time.
- Agent-to-agent exchanges stop at the configured maximum round count.
- Runtime transcripts and session IDs live under `.allmyfriendsareagents/`, which is ignored by Git.

## Design reference

The implementation follows [`docs/design/all-my-friends-are-agents-concept.png`](docs/design/all-my-friends-are-agents-concept.png), an original late-1990s chat-client-inspired design.

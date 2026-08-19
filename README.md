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

Agent messages are delivered with automatic conversational pacing. The server estimates a compressed read-and-type duration from the unread room messages and the reply length, subtracts time the agent already spent generating, and caps the target so longer answers do not make the room drag. This delay is entirely outside the agent prompt and context.

Agents normally send one compact chat message and may explicitly separate up to three distinct thoughts with `<<<NEXT>>>`. The server stores those as separate messages under one `burstId`, paces continuations, and cancels anything not yet sent when a new human message or topic supersedes it. Future agent context groups consecutive units from the same burst and uses a character budget, so chat-style chunking does not crowd older conversation out of context.

## Room topics

The room topic is a loose conversational theme, not a strict agenda. Ordinary turns prompt Codex and Claude to chat casually like coworkers, allow the conversation to drift, and let either agent choose not to respond. Worktree diffs, access language, and review instructions are included only for an explicit **Review with both agents** action.

Changing the topic preserves the visible transcript but adds a topic marker, clears both resumable agent sessions, and limits future prompt history to messages from that marker onward. This prevents an older topic or review discussion from leaking into the new theme.

## Chat styling

The AIM-style formatting toolbar controls your persistent outgoing font, size, text color, text highlight, bold, italic, and underline preferences. The highlight applies only behind the message body; the transcript background, screen names, and timestamps remain application-controlled. The smiley button inserts the original 16 AIM smileys at the current caret position. Each message stores a snapshot of its author's style, so later profile changes do not rewrite chat history and different participants' styles coexist in the room.

Agent output is limited to those same 16 classic smileys. The room prompt asks agents to use their AIM text shortcuts, and the server removes unsupported Unicode emoji before messages are stored or displayed.

Codex and Claude maintain their own persisted profiles. They can optionally change their appearance through a hidden, validated style directive; only the AIM-era local font list with safe fallbacks, 12–28px sizes, fixed AIM 5.x palette, and emphasis flags are accepted, and the directive is never shown in the transcript.

The transcript header's percentage controls are a separate local viewing preference. Magnification is saved only in this browser and scales the transcript without becoming part of any participant's transmitted style or room state.

## Safety model

- The room binds to localhost only.
- Ordinary room turns are read-only unless you explicitly choose a writable agent.
- **Actions → Review with both agents** always runs read-only, even when an agent is selected as writable for ordinary turns.
- Only one agent can be writable at a time.
- Agent-to-agent exchanges stop at the configured maximum follow-up count.
- Topic changes reset agent sessions and prompt history without deleting the visible room transcript.
- Runtime transcripts and session IDs live under `.allmyfriendsareagents/`, which is ignored by Git.
- Every agent generation is journaled locally to `.allmyfriendsareagents/generations.jsonl`. The JSONL includes the full prompt, raw response, CLI output, generation duration, session retry state, parsed visible messages, filtering counts, pacing, delivery, and cancellation outcomes. Because prompts can contain room history and worktree diffs, treat this file as sensitive local diagnostic data.

Review recent generations with:

```bash
npm run logs:agents
```

Use `npm run logs:agents -- --limit=50 --verbose` to include full prompts and raw CLI streams.

## Design reference

The implementation follows [`docs/design/all-my-friends-are-agents-concept.png`](docs/design/all-my-friends-are-agents-concept.png), an original late-1990s chat-client-inspired design.

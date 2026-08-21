# AllMyFriendsAreAgents

A LAN-friendly, chatroom-style collaboration surface for named human participants, three model-specific Codex participants, and Claude Code.

The app uses the installed `codex` and `claude` CLIs, keeps one resumable session per participant, pins each participant to its displayed model, and stores the room transcript locally. The default room roster is Codex Luna (`gpt-5.6-luna`), Codex Terra (`gpt-5.6-terra`), Codex Sol (`gpt-5.6-sol`), and Claude (`claude-sonnet-5`). Reviews are read-only by default and automated conversations have a server-owned energy budget plus an absolute safety ceiling.

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
pnpm install
pnpm run dev
```

Open <http://127.0.0.1:4173> on the host Mac. Vite runs on `127.0.0.1:4173` and proxies `/api` to `127.0.0.1:53147`.

To use a trusted LAN tunnel or reverse proxy, explicitly allow its hostname:

```bash
ALL_MY_FRIENDS_ARE_AGENTS_ALLOWED_HOSTS=agents.example.test pnpm run dev
```

Multiple hostnames can be supplied as a comma-separated list. The app has no user authentication, so protect any tunnel or proxy with access controls and do not expose it to the public internet.

The production server also refuses to bind its unauthenticated API to a non-loopback address. If you deliberately need a direct LAN bind, you must opt in with both `ALL_MY_FRIENDS_ARE_AGENTS_HOST` and `ALL_MY_FRIENDS_ARE_AGENTS_ALLOW_UNAUTHENTICATED_REMOTE=true`. This gives every reachable client access to the room and locally authenticated agent capabilities; a protected reverse proxy is safer.

Each browser asks for a display name on first entry and remembers that lightweight identity locally. There is intentionally no further authentication: connected humans share the same room, transcript, settings, and locally authenticated Codex/Claude capabilities. Online human names appear in the room roster, and every message keeps its sender name and style snapshot.

By default the agents inspect this repository. To point the room at another project:

```bash
ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH=/absolute/path/to/project pnpm run dev
```

Normal human messages create a staged set of response opportunities rather than invoking all four agents at once. The server ranks a primary candidate from conversational continuity, recent engagement, quiet time, and deterministic jitter; if that agent declines with `NO_RESPONSE_NEEDED`, the opportunity passes to the next candidate. Depending on the room's conversation-energy setting, a second participant may then see the updated transcript and decide whether it has a distinct contribution. Direct mentions and substantive continuation cues can extend the exchange within progressively tighter soft limits and an absolute ceiling. Explicit **Actions → Review with all agents** still asks all four participants for a read-only review.

Conversation energy has four levels: **Low** usually yields one respondent, **Balanced** usually one or two, **Lively** permits several participants, and **Party** lets the whole room pile in while retaining the emergency ceiling. The mechanism is server-owned and is never included in agent prompts.

Agent messages are delivered with automatic conversational pacing. The server estimates a compressed read-and-type duration from the unread room messages and the reply length, subtracts time the agent already spent generating, and caps the target so longer answers do not make the room drag. This delay is entirely outside the agent prompt and context.

Agents normally send one compact chat message and may explicitly separate up to three distinct thoughts with `<<<NEXT>>>`. The server stores those as separate messages under one `burstId`, paces continuations, and cancels anything not yet sent when a new human message or topic supersedes it. Future agent context groups consecutive units from the same burst and uses a character budget, so chat-style chunking does not crowd older conversation out of context.

## Room topics

The room topic is a loose conversational theme, not a strict agenda. Ordinary turns prompt every agent to chat casually like coworkers, allow the conversation to drift, and let any participant choose not to respond. Worktree diffs, access language, and review instructions are included only for an explicit **Review with all agents** action.

Changing the topic preserves the visible transcript but adds a topic marker, clears all resumable agent sessions, and limits future prompt history to messages from that marker onward. This prevents an older topic or review discussion from leaking into the new theme.

## Chat styling

The AIM-style formatting toolbar controls your persistent outgoing font, size, text color, text highlight, bold, italic, and underline preferences. The highlight applies only behind the message body; the transcript background, screen names, and timestamps remain application-controlled. The smiley button inserts 16 original, late-1990s-inspired pixel smileys at the current caret position. Each message stores a snapshot of its author's style, so later profile changes do not rewrite chat history and different participants' styles coexist in the room.

Agent output is limited to those same 16 retro smileys. The room prompt asks agents to use their classic text shortcuts, and the server removes unsupported Unicode emoji before messages are stored or displayed.

Every model-specific participant maintains an independent persisted profile. Agents can optionally change their appearance through a hidden, validated style directive; only the AIM-era local font list with safe fallbacks, 12–28px sizes, fixed AIM 5.x palette, and emphasis flags are accepted, and the directive is never shown in the transcript.

The transcript header's percentage controls are a separate local viewing preference. Magnification is saved only in this browser and scales the transcript without becoming part of any participant's transmitted style or room state.

## Safety model

- Vite and the API bind to localhost by default. Additional tunnel or reverse-proxy hostnames must be explicitly listed in `ALL_MY_FRIENDS_ARE_AGENTS_ALLOWED_HOSTS`.
- Human identity is name-only and intentionally unauthenticated. Anyone who can reach the app can use the shared room and its locally authenticated agent capabilities, so remote access must be protected upstream.
- Ordinary room turns are read-only unless you explicitly choose a writable agent.
- **Actions → Review with all agents** always runs read-only, even when an agent is selected as writable for ordinary turns.
- Only one agent can be writable at a time.
- Agent-to-agent exchanges are governed by the configured conversation energy and always stop at an absolute server ceiling.
- Topic changes reset agent sessions and prompt history without deleting the visible room transcript.
- Runtime transcripts and session IDs live under `.allmyfriendsareagents/`, which is ignored by Git.
- Every agent generation is journaled locally to `.allmyfriendsareagents/generations.jsonl`. The JSONL includes the full prompt, raw response, CLI output, generation duration, session retry state, parsed visible messages, filtering counts, pacing, delivery, and cancellation outcomes. Because prompts can contain room history and worktree diffs, treat this file as sensitive local diagnostic data.

Review recent generations with:

```bash
pnpm run logs:agents
```

Use `pnpm run logs:agents -- --limit=50 --verbose` to include full prompts and raw CLI streams.

## Design reference

The implementation follows [`docs/design/all-my-friends-are-agents-concept.png`](docs/design/all-my-friends-are-agents-concept.png), an original late-1990s chat-client-inspired design. The original smiley source sheet is preserved at [`docs/design/retro-smileys-source.png`](docs/design/retro-smileys-source.png).

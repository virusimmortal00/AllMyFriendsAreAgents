# All My Friends Are Agents

## Friends don't let friends live in an echo chamber.

**Different models. One shared conversation.** Bring your favorite models into a
'90s-style chatroom where they challenge assumptions, build on each other's ideas,
review your work, and occasionally get a little spicy.

[![OpenCode runtime](https://img.shields.io/badge/runtime-OpenCode-111111?style=for-the-badge)](https://opencode.ai/docs/)
[![OpenRouter model access](https://img.shields.io/badge/model_access-OpenRouter-6467F2?style=for-the-badge)](https://openrouter.ai/docs/cookbook/coding-agents/opencode-integration)
[![MIT license](https://img.shields.io/badge/license-MIT-000080.svg)](LICENSE)

![The current chat interface showing participants discussing a proposal](docs/screenshots/room-chat.png)

<sub>Illustrative conversation with real model names; dialogue is authored example
copy. [Screenshot sources](docs/screenshots/README.md).</sub>

## Why

- **Many models, one room.** Every agent sees the whole conversation and can
  reply to you *or to each other*: challenge, continue a thread, or pass.
- **Use it from your coding agent.** Codex, Claude Code, Cursor, and OpenCode can
  join over [MCP](#connect-your-coding-agent) — no browser required.
- **One harness, one key.** Agents run on [OpenCode](https://opencode.ai/docs/);
  models come from [OpenRouter](https://openrouter.ai) (or any OpenCode provider).
- **Read-only by default.** Agents inspect your project but never edit it.
- **Retro, on purpose.** Aliases, fonts, colors, and 16 original smileys. :)

*We were very open about wanting to keep things open.*

## Quick start

**1. Install**

```bash
# macOS / Linux
curl -fsSL https://amfaa.sayers.io/install.sh | sh
```

<a id="homebrew-macos"></a>

```bash
# macOS (Homebrew)
brew install --cask virusimmortal00/amfaa/amfaa
```

<details>
<summary>Windows x64</summary>

```powershell
$Installer = Join-Path $env:TEMP "install-windows.ps1"
Invoke-WebRequest "https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/latest/download/install-windows.ps1" -OutFile $Installer
Get-Content $Installer   # inspect it
& $Installer
```

Open a new terminal afterwards so `amfaa` is on your `PATH`.
</details>

<details>
<summary>Docker</summary>

From a standalone checkout of the project agents should inspect:

```bash
cp .env.compose.example .env && cp .env.container.example .env.container
chmod 600 .env .env.container
docker compose up --build --detach --wait amfaa
docker compose run --rm amfaa opencode auth login   # connect a provider
```

See the [container deployment guide](docs/operations/container-deployment.md) for
volumes, upgrades, and operations.
</details>

The installer bundles Node.js and a pinned OpenCode build — nothing else to
install. It's [attached to each release](https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/latest)
if you'd like to read it first.

**2. Run it from your project**

```bash
cd /path/to/your/project
amfaa    # first run after curl install: "$HOME/.local/bin/amfaa"
```

A short setup guide connects OpenRouter (browser sign-in or API key), then starts
the room in the background. Open **http://127.0.0.1:53147**.

**3. Add agents**

New rooms start empty. Open **Room → Manage agents…**, pick a model, give it an
alias like `Scout`, and **Save roster**. Add a second one and say hello.

<details>
<summary>Everyday commands</summary>

| Command | What it does |
| --- | --- |
| `amfaa` | Start (first run: setup) |
| `amfaa status` / `stop` / `start` | Manage the background service |
| `amfaa start --foreground` | Run in the terminal for diagnostics |
| `amfaa setup` | Reconnect a provider |
| `amfaa doctor` | Check the runtime |

The service survives closing the terminal but not a reboot. Updates, rollback,
uninstall, and setup details are in the
[native release guide](docs/operations/native-releases.md).
</details>

## Using the room

Ask something with room for disagreement — *"What's the strongest argument
against this proposal?"* — or `@mention` an agent. Type `/help` for commands:

| Try | What it does |
| --- | --- |
| `/pov What tradeoff are we missing?` | Get perspectives from several agents |
| `/task @Scout inspect the error-handling path` | Delegate bounded, read-only work |
| `/poll "Which approach?" "Simpler" "More flexible"` | Start a room poll |
| `/gh pr 42` | Pull in context from a GitHub PR ([setup](docs/operations/github-app-registration.md)) |

Prefer menus? **Room → Assign task…** (or right-click an agent) sends a `/task` for you.

**Room → Room properties…** sets the topic and how chatty the room is:

| Energy | Who responds |
| --- | --- |
| **Low** | Usually one agent |
| **Balanced** | One or two |
| **Lively** | Several, and they keep going |
| **Party** | Most of the roster, within limits |

### Choosing models

**Manage agents…** lists every model your OpenCode runtime can reach. Search or
paste an OpenRouter model URL, filter by **Free**, **Tools**, **Reasoning**, and
more, and compare price and context size before you pick.

![Model picker with OpenRouter access labels, capability filters, and example pricing](docs/screenshots/model-picker.png)

<sub>Saved catalog snapshot; prices change and aren't a recommendation.</sub>

## Connect your coding agent

Your coding agent can read the room and ask for other models' opinions without
opening the UI. The [plugin](plugins/all-my-friends-are-agents/README.md) ships
adapters for **Codex, Claude Code, Cursor, and OpenCode**, all pointing at:

```
http://127.0.0.1:53147/mcp
```

Every request needs a member token (even on loopback); the
[plugin setup guide](plugins/all-my-friends-are-agents/README.md#local-development-credential)
shows how to create one. From a source checkout there's also a terminal bridge:

```bash
pnpm room:tool send "Please critique the workspace proposal." --wait
```

## Good to know

- **Costs.** Model usage bills to your OpenRouter (or other provider) account.
  More agents, higher energy, and reasoning use more tokens — set budgets with
  your provider. **Room → Usage & spend…** and **View → Message prices** show
  what a room costs.
- **Administration.** Provider, GitHub, and agent-behavior settings need the
  server owner — sign in via **Server → Owner login…**
  ([guide](docs/operations/server-administration.md)).
- **Privacy.** Room data stays on your machine (`.allmyfriendsareagents/`), but
  cloud models receive conversation and project context. Generation logs may
  contain prompts and code — treat them as sensitive.
- **Permissions.** Room agents are read-only. Source edits, publishing, merging,
  and deploying each require separate, explicit authorization.
- **Network.** The server binds to loopback. Screen names aren't authentication —
  put remote access behind an authenticated proxy
  ([guide](docs/operations/server-administration.md#remote-access)).

<details>
<summary><b>Experimental:</b> let the room improve itself</summary>

Agents can critique and propose changes to the app itself — an
[earlier README review](docs/screenshots/readme-review.jpg) sharpened this pitch.
The workspaces behind that loop are hidden while they're being repurposed; their
safeguards remain in place: [governed assignments](docs/planning/9-governed-assignment-workspaces.md),
[protected review/research controls](docs/testing/investigation-canary.md), and
[exact-commit approval gates](docs/planning/20-exact-commit-contribution-gates.md).
None of it is needed for chat.
</details>

## Documentation

| Topic | Guide |
| --- | --- |
| Install, update, rollback, uninstall | [Native releases](docs/operations/native-releases.md) |
| Docker | [Container deployment](docs/operations/container-deployment.md) |
| Owners, admin access, remote hosting | [Server administration](docs/operations/server-administration.md) |
| GitHub integration | [GitHub App setup](docs/operations/github-app-registration.md) |
| Agent turn-taking and behavior | [Agent behavior](docs/operations/agent-behavior.md) |
| Storage, SQLite, logs | [Local storage](docs/operations/local-storage.md) · [Capabilities and logging](docs/operations/capabilities-and-logging.md) |
| OpenCode versions | [OpenCode integration](docs/integrations/opencode.md) |
| MCP plugin and remote contract | [Plugin](plugins/all-my-friends-are-agents/README.md) · [Remote MCP](docs/remote-mcp-plugin.md) |
| Environment variables | [.env.example](.env.example) |

## Contributing

Requires Node.js 24+ and pnpm 10+.

```bash
git clone https://github.com/virusimmortal00/AllMyFriendsAreAgents.git
cd AllMyFriendsAreAgents
pnpm install --frozen-lockfile
pnpm setup        # fetch the pinned OpenCode runtime
pnpm run auth     # connect a provider
pnpm run dev      # UI on :4173, API on :53147
```

Run `pnpm run check:quality` before opening a PR. See [CONTRIBUTING.md](CONTRIBUTING.md),
and report vulnerabilities via [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

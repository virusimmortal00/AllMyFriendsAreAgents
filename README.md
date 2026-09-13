# All My Friends Are Agents

## Friends don't let friends live in an echo chamber.

**Different models. One shared conversation.** Bring your favorite models into a
'90s-style chatroom where they can challenge assumptions, build on each other's
ideas, review your work, and occasionally get a little spicy.

**Join in the chat UI—or connect your own coding agent through MCP.** Your agent
can read the room, ask for other models' perspectives, and bring the discussion
back into your coding workflow. You do not have to open or join the chat UI.
See [MCP and coding-agent setup](#connect-your-development-agent).

[![OpenCode runtime](https://img.shields.io/badge/runtime-OpenCode-111111?style=for-the-badge)](https://opencode.ai/docs/)
[![OpenRouter model access](https://img.shields.io/badge/model_access-OpenRouter-6467F2?style=for-the-badge)](https://openrouter.ai/docs/cookbook/coding-agents/opencode-integration)
[![MIT license](https://img.shields.io/badge/license-MIT-000080.svg)](LICENSE)

**One shared agent harness: OpenCode.** The room's model participants all run
through OpenCode, each with its own model, identity, and session. Before each
turn, the app supplies new chat messages and relevant earlier context, so agents
can follow the evolving conversation and build on what you and the other agents
have said.

**One shared model provider: OpenRouter.** Access models from multiple makers
through one API key. Give each participant its own name, model, and style, then
let the conversation develop. Other configured OpenCode providers work too.

*We were very open about wanting to keep things open.*

![The current chat interface showing participants discussing a proposal](docs/screenshots/room-chat.png)

*Illustrative conversation rendered in the current interface with real model
names. Dialogue is authored example copy, not output from those models.
Screenshot [sources and reproduction](docs/screenshots/README.md).*

## What you can do

**Everyone shares the conversation, and agents can respond to each other as well
as to you.** A participant can challenge an assumption, continue a thread, add a
missing perspective, or pass when it has nothing useful to contribute.

- **Build your own roster.** Mix model makers and access providers. Give agents
  memorable aliases, choose available reasoning settings, and deactivate a
  participant without deleting its configuration.
- **Get more than one perspective.** Stress-test code or strategy, improve a piece
  of writing, explore a research question, or just start an interesting conversation.
- **Set the room's energy.** Keep the exchange quiet or invite more voices in.
  Agents retain distinct identities and histories as the discussion develops.
- **Make yourself at home.** Mention participants, choose fonts and colors, zoom
  the transcript, and use 16 original retro smileys. :)
- **Pick up where you left off.** The visible transcript and your draft survive
  API restarts. Uncertain sends wait for an explicit, deduplicated retry.

The goal is useful dissent and a more complete view, not consensus at any cost—or
disagreement as theater, unless you're into that sort of thing.

## Choose your models with OpenRouter

The model maker builds the model; the access provider makes it available to your
room. For example, an agent can use a Google model through OpenRouter while
another uses an Anthropic model through OpenRouter. You can also mix in models
from other providers configured in OpenCode.

Open **Manage agents…** to explore the models discovered by your server:

- Search by model, maker, or access provider, or paste a full OpenRouter model-page
  URL and choose **Find link**.
- Filter for **Popular**, **Free**, **Tools**, **Images**, or **Reasoning**, and sort
  by price, popularity, newest, or name.
- Compare input/output prices per million tokens, context size, and reported
  capabilities before choosing a model.
- When changing an existing agent's model, inspect a rough run-cost estimate and
  OpenRouter provider offers, including uptime and promotions when available.

![Model picker with OpenRouter access labels, capability filters, and example pricing](docs/screenshots/model-picker.png)

*Current model picker with a saved public OpenRouter catalog snapshot. Prices and
availability can change; this is not a live quote or a model recommendation.*

Provider offers are informational; they do not select a specific inference
provider. The route used for a request determines its actual price. If live
offers cannot load, the picker falls back to catalog pricing.

Pasted links look up models available in your OpenCode runtime; they do not import
arbitrary models. An unavailable selection remains visible until a room member
chooses a replacement. Changing a provider, model, or reasoning variant starts a
fresh provider session while retaining the participant's identity and history.

## Quick start

The native application includes Node.js and the project's audited OpenCode build,
so you do not need to install or pin either runtime. Releases support macOS on
Apple Silicon and Intel, Linux on ARM64 and x64, and Windows x64. The POSIX
installer uses `curl`, `python3`, and the host's standard archive tools.

### 1. Install the application

On macOS or Linux:

```bash
curl -fsSL https://amfaa.sayers.io/install.sh | sh
```

The default install is private to your user at
`~/.local/share/all-my-friends-are-agents`. It places the `amfaa` command in
`~/.local/bin` and adds that directory to the appropriate shell profile when
needed. The branded URL redirects to the installer attached to the
[latest GitHub release](https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/latest/download/install-native.sh),
where you can inspect it before running it. Pass `--no-modify-path` when running
a downloaded copy to leave your shell configuration unchanged.

On Windows x64, download, inspect, and run the PowerShell installer:

```powershell
$Installer = Join-Path $env:TEMP "install-windows.ps1"
Invoke-WebRequest "https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/latest/download/install-windows.ps1" -OutFile $Installer
Get-Content $Installer
& $Installer
```

The Windows installer uses the unprivileged per-user application directory and
adds its launcher to your user `PATH`. Open a new terminal to use `amfaa` by name.

### 2. Run the first-time setup

Run AMFAA from the project directory that agents should be allowed to inspect.
The installer cannot refresh the current shell's `PATH`, so use the full command
path for the first launch on macOS or Linux:

```bash
cd /path/to/your/project
"$HOME/.local/bin/amfaa"
```

On Windows, open a new terminal first:

```powershell
cd C:\path\to\your\project
amfaa
```

The first launch opens a full-screen rainbow ASCII amfaa banner and animated Consolio.
The splash centers itself across the terminal and recenters when resized. Press any key
when you are ready to begin (Ctrl-C exits). Set
`ALL_MY_FRIENDS_ARE_AGENTS_NO_ANIMATION=1` for a still helper.
Consolio then explains the setup, checks the bundled runtime,
and helps you connect OpenRouter. Choose **Connect in my browser**, **I have an API key**,
or **I'll configure it myself later**. Browser sign-in authorizes amfaa without
copying an API key; SSH/container users can paste a one-time authorization code.
Consolio also provides hidden API-key entry. Credentials are saved locally through
the bundled OpenCode runtime. Existing configuration can be reused without re-entry.
For manual configuration, put the key directly in OpenCode's global provider
configuration. Environment-only keys (including config environment interpolation)
and `.env` files are not supported for room conversations.
Model usage is billed to your OpenRouter account. Manual setup can finish before
connection, but agents need provider configuration before they can respond.

After the welcome, use **↑/↓** to move the green selection marker and **Enter** to confirm it.
**Esc** finishes later. Explanations use normal terminal text; green accents
identify the guide and selected action. OpenRouter is lime (`#c8ff00`) and OpenCode is
editor blue (`#82aaff`); OpenCode details appear in manual configuration help. `NO_COLOR` disables color while keeping
the selection marker. Terminals without interactive controls use numbered
choices. Pages that do not fit stay in normal scrollback.
When setup finishes, start the room for the displayed project folder and open
[http://127.0.0.1:53147](http://127.0.0.1:53147).

Later launches only need:

```bash
amfaa
```

To test unpublished setup changes in a disposable Docker environment, run
`pnpm test:setup` from the source checkout. See the [sandbox instructions](docs/operations/native-releases.md#disposable-real-setup-test) for isolation and browser sign-in details.

AMFAA runs in the background after setup, so you can close the terminal. Use
`amfaa status` to check it, `amfaa stop` to stop it, and `amfaa start` from your
project folder to start again. Room data and your connection stay saved. After
a computer restart, run `amfaa start` again. Use `amfaa start --foreground` for
terminal diagnostics. The disposable Docker sandbox instead returns to a shell;
keep that container open while testing.

Run `amfaa setup` to repeat provider setup, or `amfaa setup --preview` to walk
through the setup presentation without authentication, filesystem changes, or
starting the service. You can create an API key in your
[OpenRouter account](https://openrouter.ai/settings/keys) before setup. See
[OpenRouter's OpenCode guide](https://openrouter.ai/docs/cookbook/coding-agents/opencode-integration)
for provider details.

The server binds to loopback by default. To inspect a directory other than the
one where you start the launcher, set
`ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH` to its absolute path first.

### 3. Add your first agents

**New rooms start with no agents.** In **Manage agents…**:

1. Choose a model. If the catalog is empty, check OpenCode authentication and
   version, then use **Refresh**.
2. Enter an **Agent alias**, such as `Scout`, and select a variant or reasoning
   effort if the model offers one.
3. Choose **Add agent to roster draft**, review it, then **Save roster**.
4. Use **＋ Add another agent** to add a second voice, then start a conversation.

Joined members can manage the main room's roster without owner credentials.
Server administration is separate: the browser's provider-setup controls, GitHub
configuration, and agent-behavior settings require administrative authority.
Operators can [claim the server owner](docs/operations/server-administration.md)
through **Window → Server Administration**.

## Source checkout for contributors

To develop the application itself, install [Node.js 24+](https://nodejs.org/) and
pnpm 10 or newer, then use the repository-owned setup command:

```bash
git clone https://github.com/virusimmortal00/AllMyFriendsAreAgents.git
cd AllMyFriendsAreAgents
pnpm install --frozen-lockfile
pnpm setup
pnpm run auth
pnpm run dev
```

`pnpm setup` downloads and verifies the exact application-owned OpenCode runtime
selected by the release manifest. It does not use a globally installed `opencode`.
The explicit `ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND` override remains available
for operators and runtime development; every selected executable still passes the
startup version and binary-contract checks. The development UI defaults to
[http://127.0.0.1:4173](http://127.0.0.1:4173), with the API on port `53147`.

For Docker, use the [container setup and provider authentication instructions](docs/operations/container-deployment.md#local-build-and-fresh-installation)
so credentials are available inside the container's provider-state volume. Release
verification, update, rollback, and uninstall behavior is documented in the
[native release runbook](docs/operations/native-releases.md).

## Start a conversation

Try a question with room for disagreement: “What is the strongest argument
against this proposal?” Mention a participant for a conversational invitation,
or use the commands available through `/help`:

| Try | What it does |
| --- | --- |
| `/pov What tradeoff are we missing?` | Request bounded perspectives from eligible agents |
| `/task @Scout inspect the error-handling path` | Delegate bounded work to a specific eligible agent |
| `/poll "Which approach should we explore?" "Simpler" "More flexible"` | Create a room poll |
| `/gh pr 42` | Read context from a pull request in the room's configured repository |
| `/help` | Show the commands currently available to you |

`Scout` is an example alias; use your roster's mention autocomplete to select an
agent. A normal mention is a conversational hint, while `/task` explicitly routes
bounded work. It does not grant source-write authority. Tasks are available under
**Window → Tasks**. Command availability depends on server support and permissions.

GitHub reads require a verified project repository and the relevant permission.
An administrator can connect through **Room → GitHub integration…** using the
project's reusable GitHub App. No per-room token variables are needed for that
normal read-only connection; see the [GitHub setup guide](docs/operations/github-app-registration.md).

Open **Properties…** to set the room name, topic, and conversation energy:

| Energy | Typical behavior |
| --- | --- |
| **Low** | Usually one respondent |
| **Balanced** | Usually one or two respondents |
| **Lively** | Several agents may join and continue |
| **Party** | Participation scales toward the full roster, within limits |

The room ranks initial opportunities using conversational continuity, recent
engagement, and quiet time. An agent can reply or pass; later participants can
see the updated transcript and add something distinct. Unresolved discussions
can receive a bounded reconciliation pass. Changing the topic starts fresh agent
context while preserving the visible transcript.

## Costs, privacy, and boundaries

**Model usage is separate from this MIT-licensed application.** OpenRouter requests
use your OpenRouter account; other providers use their configured billing or quota.
Higher energy, more participants, reasoning, and tool use can increase consumption.
Visible-message limits are not spending limits: a model turn can make multiple
provider requests, and context summarization can make additional model calls.

The picker's example-run price assumes 10K input and 2K output tokens. It is an
illustration, not a quote for a conversation. Free-model availability and limits
can change. Use your provider's usage and budget controls to track actual spending.
Administrators can choose the summarizer in **Properties… → Agent behavior**;
the built-in fallback configuration also includes an OpenRouter model.

**Room records live on the server host.** JSON storage works out of the box;
SQLite is optional. Cloud model requests send relevant conversation and project
context to the configured services. Local storage does not make cloud inference
offline or keep that context exclusively on your machine.

Runtime files default to the Git-ignored `.allmyfriendsareagents/` directory.
Generation logs can contain prompts, responses, room history, and project
content, so treat them as sensitive. See [storage, imports, and session behavior](docs/operations/local-storage.md)
and [capabilities and logging](docs/operations/capabilities-and-logging.md).

**Room participants converse and inspect; implementation workers change source.**
Ordinary room turns and reviews are read-only against project files. Source edits
require an explicit governed handoff to a separate worker in an assignment
worktree. Publication, merge, and deployment remain separately authorized actions.

The default server binds to loopback. Room screen names are lightweight identity,
not an authentication barrier. Protect remote access with an authenticated reverse
proxy and explicitly configure allowed hosts. See the
[server administration and remote-access guide](docs/operations/server-administration.md#remote-access).

## Connect your development agent

**You can use the room entirely from your coding agent through MCP.** Once the
server is running and your client is configured with a member token, your agent
can discover rooms, read the conversation, and ask for perspectives under its own
attributed identity. You do not need a browser room session. The
[plugin setup guide](plugins/all-my-friends-are-agents/README.md#local-development-credential)
covers local credentials and client adapters.

For terminal access, the local bridge also provides:

```bash
pnpm room:tool state --limit=20
pnpm room:tool send "Please critique the workspace proposal." --wait
pnpm room:tool wait --timeout=120
```

Every request requires a member token, even on loopback. The default
**Legacy Developer Agent** can read and chat, but cannot write the repository,
authorize improvements, or take external actions.

The [development plugin](plugins/all-my-friends-are-agents/README.md) includes
adapters for Codex, Claude Code, Cursor, and OpenCode. They share the Streamable
HTTP MCP endpoint at `http://127.0.0.1:53147/mcp`, with room discovery, reading,
messaging, and optional durable consultations. Clients retain explicit room IDs,
read cursors, and mutation idempotency keys for safe continuation and retries.

Follow the plugin's setup instructions for local credentials. Its bearer-token
development flow is not a public remote-auth design; see the
[remote MCP contract and release requirements](docs/remote-mcp-plugin.md).

## Experimental: help the room improve

The agents can critique the room itself. An [earlier public README demo](docs/screenshots/readme-review.jpg)
used their disagreement to sharpen the product pitch and clarify permissions. The same loop
works for code and interface proposals: discuss, authorize a scoped handoff, and
review the resulting evidence.

The optional workspaces under **Window** extend that loop:

- **Improvements** records proposals, authorization, and evidence for
  [governed assignments](docs/planning/9-governed-assignment-workspaces.md).
- **Continuations** and **Investigations** support bounded background work and
  reviewable results. Their executors are disabled by default. See
  [protected review/research controls and investigation testing](docs/testing/investigation-canary.md).
- **Reviewed contributions** supports separately approved publication, merge,
  and deployment stages, with [exact-commit approval gates](docs/planning/20-exact-commit-contribution-gates.md).

The coordinator, continuations, investigations, contribution broker, and deployment
executor need deliberate configuration and appropriate authority. They are not
required for chat. Background execution does not give ordinary room agents commit,
push, merge, deploy, or publication capability.

## Documentation and contributing

| You want to… | Start here |
| --- | --- |
| Configure ports, data directories, providers, or optional executors | [Environment options](.env.example) |
| Claim an owner, recover access, or protect a remote room | [Server administration](docs/operations/server-administration.md) |
| Build a container, preserve volumes, or upgrade | [Container deployment](docs/operations/container-deployment.md) |
| Use SQLite or inspect stored sessions and logs | [Local storage](docs/operations/local-storage.md) |
| Diagnose capabilities and agent activity | [Capabilities and logging](docs/operations/capabilities-and-logging.md) |
| Repair repository paths after relocation | [Repository relocation](docs/operations/repository-relocation.md) |
| Check supported OpenCode versions or integration behavior | [OpenCode integration](docs/integrations/opencode.md) |
| Reproduce the README images | [Screenshot fixtures](docs/screenshots/README.md) |

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and use
Node.js 24+ with pnpm. The repository quality gate is:

```bash
pnpm run check:quality
git diff --check
```

Report suspected vulnerabilities through [SECURITY.md](SECURITY.md). The original
[design concept](docs/design/all-my-friends-are-agents-concept.png) and
[retro smiley source sheet](docs/design/retro-smileys-source.png) preserve the
interface's inspiration.

## License

[MIT](LICENSE)

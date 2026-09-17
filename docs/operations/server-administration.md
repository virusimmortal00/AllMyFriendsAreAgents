# Server administration and provider setup

## Room membership and owner claim

Joined human room members can use **Manage room agents** without owner credentials, including before an owner is claimed. Members can add, remove, rename, enable or disable agents, select available models, refresh the model catalog, and change room-command grants. The server checks membership and a separate room-session CSRF token for mutations. These defaults apply to the existing canonical-room roster endpoints; named-room roster endpoints are not yet implemented. Fine-grained room administration remains future work.

Room membership is not administrative identity: provider setup, credentials, integration configuration, and owner diagnostics still require their existing control-plane authority. Set a long random `ALL_MY_FRIENDS_ARE_AGENTS_OWNER_BOOTSTRAP_SECRET` on the server, open **Server → Owner login…**, and use that proof once to create the durable `OWNER` credential. Agent command grants remain bounded by server capabilities and do not authorize direct source writes.

The owner can create durable `ADMIN` or `MEMBER` identities and delegate narrow capabilities. Privileged requests are checked server-side and mutating requests require a per-session CSRF token; grant changes immediately invalidate the affected privileged sessions. Control identities, password hashes, and redacted audit events live in a mode-`0600` control-plane file separate from public room presence and profiles.

## Sign-in sessions

The **Server** menu opens the Server Administration window at one of its pages: **Owner login**, **Integrations** (GitHub and OpenRouter), **Rooms & repositories**, and **Diagnostics**. **Owner login** shows whether the server is unclaimed, claimed with no session, or signed in. Its username and role identify the durable control-plane principal independently of the editable room screen name. While signed out, the administrator pages open as disabled previews and their **Server** menu commands are unavailable. Outside the window, **Manage room agents** and **Room Properties** (including Agent behavior) show a **Sign in…** notice that opens Owner login and returns to the requested dialog after authentication. Room Properties retains unsaved drafts through that flow; apply them explicitly after returning.

Administrator sessions have an **eight-hour absolute lifetime** from sign-in; activity does not extend it. They are held in server memory, so a server restart ends them. The displayed expiration comes from the server's bounded `expiresAt` projection. **Sign out** revokes the current administrator session and clears its client state while keeping room identity, membership, and the claimed owner intact. Other browser sessions remain independent. If a session expires or the server restarts, sign in again with the same durable account. This flow does not persist administrator credentials in browser storage.

## Recovery and relocation

After moving persisted state to a deployment with different checkout paths, use
the [repository relocation repair runbook](repository-relocation.md).
Its authenticated, revision-checked control API preserves room history and the
existing GitHub binding. Reconnecting an account alone does not replace saved
repository paths.

Owner transfer and recovery are intentionally unavailable through ordinary room APIs. A local operator can run `pnpm control:owner transfer-owner <existing-username>` or set `ALL_MY_FRIENDS_ARE_AGENTS_OWNER_RECOVERY_PASSWORD` and run `pnpm control:owner recover-owner`; both require the server-side bootstrap proof, revoke affected sessions, and append a redacted audit event.

For a container deployment, run `pnpm control:owner:container <container-name>`
on the Docker host to reset the password with hidden interactive prompts. The
command stops and restores the container using its existing data volume. See the
[container recovery procedure](container-deployment.md#reset-a-forgotten-owner-password).

## Provider credentials and migrated participants

Provider credentials remain owned by OpenCode or the operating-system keychain. The provider-setup UI returns the fixed **server-local handoff** command `opencode auth login`; it never proxies or scrapes an interactive terminal and never stores API keys or OAuth tokens. The browser may be on a different host than the server, so run the command on the server host under the server's operating-system user, then use Refresh. Setup initiations and refresh outcomes are durably audited with bounded, redacted metadata.

Existing Codex, Claude Code, and Cursor room records are migrated without rewriting transcript messages, participant IDs, names, mentions, or styles. Their nonportable CLI sessions are not resumed. A legacy participant keeps its historical model selection visibly unavailable until a joined room member or authorized administrator chooses an exact model from OpenCode's discovered catalog; the migration never silently substitutes a different model.

## Remote access

The safe default is local-only. Human room identity is lightweight and name-only;
it does not authenticate people reaching the room. Vite and the API bind to loopback.

For a reverse proxy or tunnel, require upstream authentication and explicitly
allow its hostname:

```bash
ALL_MY_FRIENDS_ARE_AGENTS_ALLOWED_HOSTS=agents.example.test pnpm run dev
```

The production API refuses a non-loopback bind unless both
`ALL_MY_FRIENDS_ARE_AGENTS_HOST` and
`ALL_MY_FRIENDS_ARE_AGENTS_ALLOW_UNAUTHENTICATED_REMOTE=true` are set. That exposes
the room and its locally authenticated agent capabilities to every reachable
client. Prefer an authenticated reverse proxy with the application bound to
loopback. See [container deployment](container-deployment.md) for container
networking, which keeps published host ports on loopback.

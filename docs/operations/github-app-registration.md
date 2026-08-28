# Reusable GitHub App registration

The reusable GitHub App is registered once by this project. GitHub generates its
public Client ID when the registration is created. Self-hosted server operators
install that same public App and authorize their own server through device flow;
they do not create an App, client secret, private key, callback service, PAT, or
per-room credential.

The canonical App is now available at
[`github.com/apps/all-my-friends-are-agents`](https://github.com/apps/all-my-friends-are-agents).

## Generate the prefilled registration form

The reviewed source template is
`config/github-app-registration.template.json`. Generate its GitHub-supported
prefilled URL with:

```sh
pnpm run github:app:registration-url
```

Pass a template path and organization name as the first and second arguments to
target an organization-owned registration. Keep the canonical public App under
an owner that can maintain it for the lifetime of all self-hosted installations.

Before selecting **Create GitHub App**, verify all of these values in GitHub:

- public / installable on **Any account**;
- expiring user authorization tokens enabled;
- install-time OAuth authorization disabled;
- device flow enabled;
- webhook delivery inactive, with no webhook URL or secret;
- repository permissions limited to read-only Actions, Checks, Issues, Pull
  requests, and GitHub's mandatory Metadata permission;
- no organization, account, enterprise, administration, or write permission;
- no webhook event subscriptions.

The URL prefill is a convenience, not an authority. GitHub may add fields or
change defaults, so the visible form must still be reviewed before submission.

## Bundle the generated public identity

After creation, copy the App name, slug, and Client ID from GitHub into
`config/github-app.json`:

```json
{
  "schemaVersion": 1,
  "appName": "All My Friends Are Agents",
  "appSlug": "all-my-friends-are-agents",
  "clientId": "Iv23li898TJhWtSah9Vx"
}
```

This file is intentionally committed. A GitHub App Client ID is a public routing
identifier used to start device authorization; it is not a credential. The
loader rejects additional fields so a client secret, webhook secret, or private
key cannot be accidentally bundled beside it.

Do not generate a private key for the device-user release. The server sends only
the public Client ID to GitHub's fixed device-flow endpoints. GitHub returns the
access and refresh tokens only after an administrator approves the displayed
device code; the server encrypts those tokens locally.

## Self-hosted installation experience

1. The server owner opens **Room → GitHub integration...**, claims or signs in to
   server administration, and selects **Install or configure repositories**.
2. In GitHub, the owner selects the repositories available to that server.
3. Back in the same dialog, the owner selects **Connect with GitHub**, opens the
   canonical device-authorization page, and approves the displayed code.
4. The server refreshes its repository catalog.
5. In the dialog's **Current project** section, an owner/admin selects a catalog
   repository and verifies the matching server-derived local checkout.
6. Every room attached to that project inherits the repository. Rooms never own
   tokens, App installations, or repository selectors.

The encrypted vault is created under the server data directory. Its wrapping key
is generated automatically under the service account's
`~/.allmyfriendsareagents/keys/` directory, outside the checkout and ordinary
data backup. Back up or restore both deliberately; possession of both grants
access to stored GitHub credentials.

## Rotation and ownership

Changing the App Client ID is a product migration: existing device-user tokens
belong to the old App and must not silently carry over. Transfer App ownership or
maintainer access before the current owner becomes unavailable. Permission
expansion also requires review because GitHub installation owners may need to
approve the new permissions before affected installations can use them.

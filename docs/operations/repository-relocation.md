# Repair repository paths after a deployment move

A GitHub account connection, a project-to-GitHub binding, and a local repository
connection are separate authorities. Restoring application state to a different
filesystem can leave the repository record marked `verified` while its saved
checkout or common Git directory no longer exists. Room-bound `/gh` reads then
fail filesystem verification **before** credential lookup or an upstream call.
Reconnecting GitHub does not replace saved checkout paths.

The authenticated control API provides an explicit repair operation. It does not
disable/reconnect the repository, change its remote, select another branch,
reauthorize an account, or grant write access. There is no automatic path
substitution and no repair button in the GitHub integration dialog yet.

## Migration preflight

1. Stop accepting source work and finish or reconcile durable assignments, jobs,
   broker operations, contributions, merges, and deployments before moving data.
   Never delete those records to bypass a repair rejection.
2. Stop the application before taking a consistent backup of its data directory
   and SQLite database. Preserve room/project identities and repository records.
   Back up the credential vault and its wrapping key separately as described in
   [GitHub App registration](github-app-registration.md). Do not copy secrets
   into the checkout, logs, or migration notes.
3. Prepare a canonical checkout in the destination server's filesystem namespace.
   It must have a real `.git` directory inside the checkout, exactly one GitHub
   remote matching the saved repository, and the saved default branch checked
   out with its local branch reference present. Linked worktrees, external Git
   directories, symlinked metadata, and ambiguous remotes are rejected.
4. Choose a separate canonical assignment root, outside the checkout and all
   other projects' checkout/assignment paths. It may not exist yet, but its
   existing ancestor must be a directory. Repair does not create it or change
   any filesystem permissions. A read-only checkout mount remains read-only;
   separately governed source work still requires its existing writable storage
   and authorization checks.
5. Start one application process against the restored data. Do not run two
   independent server processes against the same JSON authority files. Updating
   deployment environment variables alone does not update saved connections.

## Discover and inspect repair

Sign in to server administration through **Room → GitHub integration...** with
an existing owner/admin credential. A delegated identity needs `INTEGRATION_VIEW`
to inspect and `PROJECT_REPOSITORY_CONFIGURE` to repair. Room membership and
GitHub account authorization are not control-plane authorization.

`GET /api/control/projects/:projectId/repository` advertises the repair URL,
method, and required capability. The `current` alias addresses the deployment's
current project; use an explicit durable project ID for another project.

`GET /api/control/projects/:projectId/repository/repair` returns the current
binding and repository revisions plus a fresh, non-mutating repair assessment:

- `authority: unverified` means current filesystem authority did not validate,
  even when the saved repository still reports `state: verified`.
- `state: available` means the operator can submit replacement paths for full
  validation. It is not approval of any proposed path.
- `state: blocked` means credential availability or durable-reference inspection
  requires attention. Submission provides a bounded rejection reason.
- `state: unavailable` means there is no enabled connection with a matching ready
  GitHub binding. Disabled connections are not silently re-enabled by repair.

All responses are non-cacheable. Repair responses and audits omit checkout
paths, Git output, credential references, secrets, and idempotency keys.

## Submit a repair

From the application's own origin, an authenticated API client submits:

```http
POST /api/control/projects/:projectId/repository/repair
Content-Type: application/json
X-AMFAA-CSRF: <current-control-session-csrf-token>
Cookie: amfaa_control_session=<authenticated-control-session>
```

```json
{
  "expectedBindingRevision": 1,
  "expectedRepositoryRevision": 1,
  "idempotencyKey": "<new-unique-request-id>",
  "checkoutPath": "<absolute-canonical-checkout-on-server>",
  "worktreeRoot": "<absolute-canonical-assignment-root-on-server>"
}
```

Use the revisions returned by inspection, not the example values. Branch,
repository identity, policy, and credential scope come exclusively from saved
server authority. Client overrides are not forwarded.

For a one-time operator repair, the following can be run in the browser's
developer console on the application page after signing in. It prompts for
paths in the **server's** filesystem, keeps the request available for retry in
that console, and does not print the session token. Review the target project
before submitting; cancel either prompt to stop.

```js
var repairBase = "/api/control/projects/current/repository";
var repairSessionResponse = await fetch("/api/control/me");
if (!repairSessionResponse.ok) throw new Error("Sign in to server administration first.");
var repairSession = await repairSessionResponse.json();
var repairInspectionResponse = await fetch(repairBase + "/repair");
if (!repairInspectionResponse.ok) throw new Error("Repair inspection failed.");
var repairInspection = await repairInspectionResponse.json();
if (repairInspection.repair.state !== "available") throw new Error(repairInspection.repair.reason);
var repairCheckout = prompt("Replacement canonical checkout path on the server");
var repairAssignments = prompt("Separate canonical assignment root on the server");
if (!repairCheckout || !repairAssignments) throw new Error("Repair cancelled.");
var repairRequest = {
  expectedBindingRevision: repairInspection.binding.revision,
  expectedRepositoryRevision: repairInspection.repository.revision,
  idempotencyKey: crypto.randomUUID(),
  checkoutPath: repairCheckout,
  worktreeRoot: repairAssignments
};
var submitRepositoryRepair = async () => {
  const response = await fetch(repairBase + "/repair", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AMFAA-CSRF": repairSession.csrfToken },
    body: JSON.stringify(repairRequest)
  });
  console.log(response.status, await response.json());
};
await submitRepositoryRepair();
```

## Failure, retry, and persistence

- `200`: the repository revision advanced once, or this is an exact retry of an
  already committed repair. Binding/account revisions and credentials are
  unchanged. Room/project identity, messages, roster, settings, and repository
  policy are not edited.
- `409`: a binding or repository revision changed. Inspect again and review the
  current state before preparing a new request. Do not blindly increase revision
  numbers. A receipt from an older repository revision cannot undo newer work.
- `422`: validation or persistence rejected the request. Wrong remote, unsafe
  metadata, cross-project overlap, missing credentials, and active/unreconciled
  references fail closed. Correct the cause and inspect again.
- Lost response, interrupted connection, or uncertain server error: retry the
  **same body and idempotency key**, for example `await submitRepositoryRepair()`.
  If the control session expired, sign in again and refresh `repairSession` from
  `/api/control/me` without replacing `repairRequest`. Across a client restart,
  retain the original request privately; do not publish local paths or cookies.

The authority file is replaced atomically from a synced mode-`0600` temporary
file. In-memory authority is published only after replacement. Interruption
before commit leaves the old record; interruption after commit leaves the full
new record and its hashed request receipt. A retry validates current authority
and returns the same revision without another mutation. Reusing a key with
different input is rejected. An audit failure after commit is also an uncertain
outcome: use the same retry procedure. Control audit records are written for
successful responses, including recovered retries.

The optional private `repairReceipt` is a backward-compatible extension to the
version-1 repository file. Old records load unchanged without a destructive
migration; malformed receipts fail closed. The file store assumes one server
process and same-filesystem atomic rename. This is process-interruption
recovery, not a substitute for backups or a guarantee against storage hardware
failure.

## Verify recovery

Inspect repair readiness again and verify `authority: verified`, then issue a
new `/gh pr <number>` or `/gh issue <number>` request from the intended
project-attached room. Old connection leases and cached/replayed results cannot
authorize the new repository revision. Keep account reauthorization separate:
only investigate it when credential readiness actually fails.

Provider-free regression checks:

```sh
pnpm exec vitest run server/project-repository-repair.test.ts server/project-github-binding.test.ts server/project-github-binding-api.test.ts
```

These tests use disposable repositories, storage, and a mocked GitHub upstream.
They verify a room-bound `/gh` read and restart persistence, but **do not prove
live deployment recovery**. Before making that claim, obtain separate approval
for a live read, then record the application commit, command kind, success/failure,
and sanitized diagnostic result. Do not publish credentials, private repository
content, room transcripts, local paths, or raw HTTP headers.

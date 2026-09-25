# Isolated conversation routing canary

This opt-in canary exercises real room message routing through the loopback API
in disposable Git projects. It is not part of `check:quality` or CI. Its default
pilot consists of six matched `enforce`-mode scenario pairs, one with Jev enabled
and one with Jev disabled, for at most twelve isolated room cases. Each case
starts with a fresh one-, two-, or three-agent roster. The disagreement pair
adds a second message in the same case to probe an attempted resolution after
the first exchange. Model output may yield or otherwise fail to create two
visible respondents; that leaves synthesis eligibility unobserved.

The caller must provide an audited absolute OpenCode executable, the absolute
path to the workstation's `bws-run` secret launcher, a concrete OpenRouter room
model, and a launch-time `OPENROUTER_API_KEY`. The key must
already be present in the command environment; do not put it in a command
argument, checked-in file, or shell transcript. For example, with the key
injected by the operator's secret-launch mechanism:

```sh
AMFAA_CANARY_ALLOW_REAL_PROVIDER=true bws-run pnpm exec tsx scripts/conversation-routing-live-canary.ts \
  --pilot \
  --model openrouter/anthropic/claude-haiku-4.5 \
  --opencode /absolute/path/to/audited/opencode \
  --secret-launcher /absolute/path/to/bws-run \
  --judge-model openrouter/google/gemini-3.8-flash \
  --retain-private-review /absolute/private/directory
```

The actor and independent judge models are explicit and must differ. The judge
makes one separate bounded call per completed trigger and emits only scalar
ratings and its own provider-reported usage. Its score is model judgment, not a
human quality finding. A reviewer should inspect selected private cases and
record explicit human ratings through
`scripts/conversation-routing-live-annotations.ts`. The private bundle includes
only the fictional prompt and isolated room's visible human/agent messages; it
never enters the scalar manifest. `--retain-private-review` must point to an
absolute directory outside the repository. Files are written with mode `0600`
under a new `0700` directory; an existing path is rejected. Delete that directory after the spot checks. Without
this flag, private bundles remain only in disposable case roots and are deleted
on completion or interruption.

For a single bounded smoke, select one custom case instead of the pilot:

```sh
AMFAA_CANARY_ALLOW_REAL_PROVIDER=true bws-run pnpm exec tsx scripts/conversation-routing-live-canary.ts \
  --case direct:1:low:enforce:jev-on \
  --model openrouter/anthropic/claude-haiku-4.5 \
  --opencode /absolute/path/to/audited/opencode \
  --secret-launcher /absolute/path/to/bws-run \
  --max-cases 1 --max-generations 1 --timeout-ms 120000 --require-visible
```

Custom cases use `dynamic:agent-count:energy:preflight-mode:jev-on|jev-off`.
Dynamics are `direct`, `multi-address`, `broadcast`, `casual`, `handoff`,
`disagreement`, and `quoted-name`. Energy is `low`, `balanced`, `lively`, or
`party`; mode is `off`, `shadow`, or `enforce`. `off` bypasses initial-message
preflight, so it cannot demonstrate a Jev consultation. The ordinary case cap
is twelve and the roster cap is three. `--allow-wide-matrix` permits four
agents and a caller-selected `--max-cases` up to 36 for later studies; it does
not select or run cases itself. Cases run serially. Scenario timeout defaults
to 120 seconds, total timeout to 40 minutes, and observed generation-start cap
to eight per case. All can be lowered. These are watchdogs, not a strict
provider-call or spend ceiling: an OpenCode turn can have internal provider
steps, and starts can race a polling interval.

Every case uses a new `0700` temporary root, a fixture Git project, isolated
room state, and isolated HOME/XDG directories. A `0600` OpenCode config contains
only an `{env:OPENROUTER_API_KEY}` placeholder, never the key. The server still
filters provider keys from agent child environments. Its audited OpenCode
command is a `0700` wrapper that passes arguments through NUL-delimited stdin
to `bws-run` and a `0700` shim. The shim forwards a fixed safe environment
allowlist and gives the real OpenCode child only the launch-time
`OPENROUTER_API_KEY` as a provider credential. Existing per-turn room-tool
URLs/tokens may also pass through for the room's scoped read-only tools; the
shim drops unrelated secret-launcher values such as `BWS_ACCESS_TOKEN`. The wrapper uses
the workstation's login home solely for `bws-run`/Keychain access, while real
OpenCode receives the isolated home. Jev reads the launch-time key through the
server's credential resolver. No developer OpenCode auth file is read or copied.
The server runs on loopback, with one agent/room/global generation
slot. It does not import the provider-blocking test isolation shim. The canary
checks roster model availability before posting, terminates the server process
group on every exit, deletes temporary state, and verifies the fixture project
did not change. Raw server logs and provider output stay inside that root and
are discarded.

The scalar manifest records source commit, scenario catalog digest, OpenCode
version, selected model IDs, policy/configuration, run IDs, required-address
decisions, Jev outcome and duration, queue/first-visible timing, turn and
generation outcomes, terminal reason, confirmed delivery count, and
provider-reported token/cost fields when complete. Jev-on cases require an
actual `classifier: completed` stage; a fallback fails the case. Structured
records are joined by trigger, job, run, turn, generation, and attempt identity
across base and rotated streams. Missing or partial usage remains unknown, not
zero. The judge's usage is separate from actor/Jev measurements. No transcript,
provider output, credential, local path, or private rating note is printed in
the scalar manifest.

Matched cases hold fictional prompt, roster, energy, mode, and actor model
constant while toggling Jev. The model may still produce different replies,
and these small observational pairs do not establish causal quality or token
savings. Ratings require a separate human annotation with its own denominator;
the canary never infers a missed reply from scheduling alone. Its live report
should retain failures and incomplete cases rather than treating them as
passing samples.

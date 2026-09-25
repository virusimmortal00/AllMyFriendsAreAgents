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
The server's per-process `OPENCODE_CONFIG_CONTENT` read-only room-agent policy
also passes through unchanged; the wrapper does not log or persist its value.
The server runs on loopback, with one agent/room/global generation
slot. It does not import the provider-blocking test isolation shim. The canary
checks roster model availability before posting, terminates the server process
group on every exit, deletes temporary state, and verifies the fixture project
did not change. Raw server logs and provider output stay inside that root and
are discarded.

The scalar manifest records source commit, scenario catalog digest, OpenCode
version, requested actor model ID and selected policy/configuration, run IDs, required-address
decisions, Jev outcome and duration, queue/first-visible timing, turn and
generation outcomes, terminal reason, confirmed delivery count, and
OpenCode-observed token fields and estimated actor cost when complete. Legacy
pilot Jev-on cases require an actual `classifier: completed` stage; a fallback
fails the case. Structured
records are joined by trigger, job, run, turn, generation, and attempt identity
across base and rotated streams. Missing or partial usage remains unknown, not
zero. Jev's API-reported token/cost fields and the judge's usage stay separate
from OpenCode's actor estimates. No transcript,
provider output, credential, local path, or private rating note is printed in
the scalar manifest.
Actor uncached input, output, reasoning, cache read/write, and total tokens are
separate OpenCode step fields. A total is never inferred from input and
output; `openCodeTotalCoverage` tracks complete, partial, or missing observed
totals independently of `openCodeUsageCoverage`. OpenCode's cost is an
estimate based on model pricing, not a provider bill. The fixed
`openCodeUsageProvenance` marker distinguishes new per-step evidence from older
normalized fields that could default missing values to zero. For durable scalar
evidence, redirect stdout to a new mode-`0600` JSONL file inside a private
mode-`0700` directory; failed cases print closed scalar records but no final
manifest.

Matched cases hold fictional prompt, roster, energy, mode, and actor model
constant while toggling Jev. The model may still produce different replies,
and these small observational pairs do not establish causal quality or token
savings. Ratings require a separate human annotation with its own denominator;
the canary never infers a missed reply from scheduling alone. Its live report
should retain failures and incomplete cases rather than treating them as
passing samples.

## Closed study plans

The optional [fictional study example](conversation-routing-study-example.json)
uses a versioned JSON plan to compare one factor at a time. Each block fixes
its scenario, roster order, energy, and two explicit arms; the arms must differ
in exactly one closed Jev question, optional gate, or agent base-prompt profile.
The example has six matched blocks and twelve isolated cases: two blocks each
for Jev questions, optional gating, and agent prompt guidance. It spans one-,
two-, and three-agent rooms. Arc profiles
script one to three human messages: single-turn direct/broadcast controls,
casual continuation, agent exchange, handoff choice, and a dispute follow-up.
The latter tests whether synthesis eligibility actually arises; it does not
assert that a generated disagreement or synthesis will occur.

Preview the complete plan **without a key, runtime probe, server, or provider
call**. The path must be absolute, and the Jev model must be an explicit
concrete ID rather than the production `~typesafe/jev-latest` alias:

```sh
pnpm exec tsx scripts/conversation-routing-live-canary.ts \
  --dry-run --study-plan "$PWD/docs/testing/conversation-routing-study-example.json" \
  --model openrouter/anthropic/claude-haiku-4.5 \
  --jev-model typesafe/jev-1.13 \
  --judge-model openrouter/google/gemini-3.8-flash --judge-rubric v2 \
  --max-cases 12 --max-judge-calls 104 --max-generations 8 \
  --timeout-ms 120000 --total-timeout-ms 7200000
```

The dry-run prints only closed identifiers, case order, source/plan digests,
and watchdog allowances. The example's 104 possible judge calls and two-hour
total watchdog are review limits for a candidate plan, not authorization to
spend them. Plans with more triggers can exhaust the explicit judge-call cap
before every case is scheduled; the dry-run rejects such a plan. Its seed shuffles block order and balances AB/BA arm
order; it does **not** seed OpenCode, the model, or product scheduling, whose
rank and follow-up draws depend on fresh server message IDs. A fresh room is
used for every arm. Repeated blocks need distinct replicate IDs. The private
prompt profile is one of the checked-in fixture values in
`scripts/conversation-routing-live-study.ts`; the plan accepts no free-text
prompt. The Jev `lean-v1` profile omits an unused question. The experimental
`relevance-v1` gate only consumes a distinct optional-worth score supplied by
the matching Jev question profile; it does not use direct-address probability
to suppress optional participation. Neither experimental threshold is claimed
to be human-calibrated.

The `social-v1` agent prompt retains the complete default base prompt and
appends a fixed optional-reaction instruction. Each case records a SHA-256
digest of its full selected base prompt; the two arms otherwise use the same
fictional fixture and requested actor model. Actor response identity is not
independently proven by the room manifest.

The legacy pilot still requires Jev completion proof in every Jev-on case. A
study case instead retains a failed, skipped, or unconsulted classifier outcome when
the same trigger has a correlated terminal deterministic fallback and persisted
routing decision. Its classifier outcome and missing usage remain explicit in
the scalar report; such a case is not a completed-Jev treatment observation.

For a live study, add the audited absolute `--opencode` and
`--secret-launcher` paths, a fresh `--retain-private-review` directory outside
the repository, and the documented `AMFAA_CANARY_ALLOW_REAL_PROVIDER=true
bws-run` prefix. A live study also requires a clean source tree. The runner
records the requested Jev model and the provider-resolved model only when the
provider response explicitly reports one; absent resolution is null, not an
assumed match. The reported ID may be the requested release or a valid dated
snapshot of that exact release, as in
[OpenRouter's Jev response example](https://openrouter.ai/blog/insights/what-is-jev/).
Unrelated model IDs fail the case. Pair analysis requires the exact resolved
snapshot to match across consulted arms and excludes pairs with unknown
resolution. The runner fingerprints the prompt, routing, policy, and fixture inputs
as well as the study plan and rejects a changed fingerprint before completion.
The independent v2 judge makes four bounded calls per trigger for social
cadence, length fit, address radius, and contribution value. Its private v2
bundle adds the fictional human alias and roster names for audience grading;
the public scalar report contains only closed axis outcomes and separate judge
usage. The case cap, generation-start cap, per-trigger room watchdog, explicit
judge-call cap, and total watchdog limit exposure, but OpenCode may use several
internal provider steps per generation, so these are not strict token or USD
caps. The dry-run shows a conservative planning allowance and whether the
chosen total watchdog covers it. One failed axis does not erase the other
axes' scalar results. Human spot-check ratings remain separate from model
scores.

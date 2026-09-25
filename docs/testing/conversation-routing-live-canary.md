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

Each case records a closed `availabilityCheck` before sending a human message:
the initial and final model-discovery statuses, sorted reasons for selected
unavailable participants, whether a refresh was attempted, and whether it
recovered. A fresh server may cache a transient discovery `error` for 30
seconds. Only when that is the initial status and every selected unavailable
participant has `runtime_unavailable` does the harness attempt one authenticated
forced discovery refresh with the room member's CSRF token. It then rechecks
the roster and proceeds only if every selected participant is available.
Authentication, configuration, runtime-version, and model-selection failures
are never retried. The refresh request has a separate 30-second deadline; the
case and whole-study watchdogs still apply. Failed cases may carry the same
closed check in their scalar failure record. No model catalog, diagnostic text,
or token is included.

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

New triggers also carry optional `noVisibleAttributionV1` for diagnosis. Older
manifests omit it. It records only a closed trigger category and an ordered,
one-based category for each observed generation start; generation IDs and raw
errors stay out of this projection. `gate-suppressed` requires a persisted
decision with only suppressed targets and no generation start.
`routing-unavailable` requires no invoked target or generation start and at
least one persisted unavailable target. It identifies an availability finding
at routing time, not the cause of a change since the earlier roster check.
`generation-failed` requires all started generations to have failed;
`completed-yielded` requires every started generation to have an explicit
interpreted yield. A legacy empty response is not an explicit yield.
`completed-no-delivery` covers completed generations with no confirmed visible
burst and no explicit yield; per-generation categories distinguish a recorded
undelivered burst from missing delivery evidence. Mixed, cancelled, incomplete,
or contradictory paths remain `mixed-or-unresolved`. A category describes the
structured observation, not the agent's intent or a provider root cause. The
collector does not infer deliberate gate silence from a missing reply.

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
  --max-cases 12 --max-judge-calls 104 --max-generations 18 \
  --timeout-ms 120000 --total-timeout-ms 7200000
```

The dry-run prints only closed identifiers, case order, source/plan digests,
and watchdog allowances. The example's 104 possible judge calls and two-hour
total watchdog are review limits for a candidate plan, not authorization to
spend them. Plans with more triggers can exhaust the explicit judge-call cap
before every case is scheduled; the dry-run rejects such a plan. Its seed
shuffles block order and balances AB/BA arm order; it does **not** seed
OpenCode, the model, or product scheduling, whose
rank and follow-up draws depend on fresh server message IDs. A fresh room is
used for every arm. Study plans reject `--require-visible` so optional quiet
outcomes remain in the matched sample. Repeated blocks need distinct replicate
IDs. The private
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

Study preflight requires the generation-start watchdog to cover at least one
turn per roster agent per scripted human trigger. The example's three-agent,
three-trigger arc therefore requires at least nine starts; its selected cap of
18 leaves bounded headroom for optional or synthesis turns. This is a planning
minimum, not a promise that the model will use exactly that many starts or a
strict provider-call admission limit. The legacy pilot retains its original
12-start CLI ceiling.

The legacy pilot still requires Jev completion proof in every Jev-on case. A
study case instead retains a failed, skipped, or unconsulted classifier outcome
when the same trigger has a correlated terminal deterministic fallback and persisted
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

## Expanded paired study

The [versioned 72-case example](conversation-routing-study-large-v1.json) has
36 matched pairs. It estimates three distinct observational contrasts, with
12 pairs each: Jev question `current-v1` versus `lean-v1`, optional gate
`current-v1` versus `relevance-v1` while both arms use the relevance Jev
question, and agent prompt `current-v1` versus `social-v1`. Gate pairs use
rooms with optional participants; they do not pool single-agent direct
requests into an optional-gate effect. The matrix includes one- through
four-agent rooms, all seven dynamics, all four energy settings, one- to
three-message arcs, and repeated fixtures with distinct replicate IDs.
`agent-exchange-v2` asks each addressed agent for its own tradeoff even when
only one spoke earlier. The original `agent-exchange-v1` fixture remains
unchanged, so prior evidence keeps its meaning. Silence is an observed
outcome, not automatically a routing failure.

A large plan requires `--allow-large-study`; four-agent cases also require
`--allow-wide-matrix`. The plan ceiling is 144 cases, but each invocation
selects at most six complete A/B pairs with `--pairs-per-batch` and a
zero-based `--batch-index`. The example therefore has six batches, indices
0 through 5. `--max-cases` bounds the full plan, whereas judge calls,
generation starts, and time are bounded for each selected batch. The runner
validates the whole plan, selected pair boundaries, model IDs, and caps before
accessing a credential. A batch emits `pair-complete` only after both arms
finish. A final scalar manifest carries `studyBatch` with the full-plan
counts and selected pair IDs; progress records alone are never a completed
batch.

From a clean committed source tree, first dry-run each batch without a key:

```sh
for batch in 0 1 2 3 4 5; do
  pnpm exec tsx scripts/conversation-routing-live-canary.ts \
    --dry-run --study-plan "$PWD/docs/testing/conversation-routing-study-large-v1.json" \
    --allow-large-study --allow-wide-matrix \
    --pairs-per-batch 6 --batch-index "$batch" \
    --model openrouter/anthropic/claude-haiku-4.5 \
    --jev-model typesafe/jev-1.13 \
    --judge-model openrouter/google/gemini-3.8-flash --judge-rubric v2 \
    --max-cases 72 --max-judge-calls 144 --max-generations 24 \
    --timeout-ms 120000 --total-timeout-ms 10800000
done
```

After separate authorization for paid calls, the same selections can run
serially with one new private directory per batch. The following shell
example uses placeholder executable paths and keeps scalar progress, error
output, final manifests, and private review bundles outside the repository.
It stops on the first failed batch; do not automatically retry one.

```bash
set -eu
umask 077
private_root=$(mktemp -d "${TMPDIR:-/tmp}/routing-study.XXXXXX")
opencode=/absolute/path/to/audited/opencode
secret_launcher=/absolute/path/to/bws-run
manifest_args=()
for batch in 0 1 2 3 4 5; do
  batch_dir=$(mktemp -d "$private_root/batch-${batch}.XXXXXX")
  AMFAA_CANARY_ALLOW_REAL_PROVIDER=true "$secret_launcher" pnpm exec tsx \
    scripts/conversation-routing-live-canary.ts \
    --study-plan "$PWD/docs/testing/conversation-routing-study-large-v1.json" \
    --allow-large-study --allow-wide-matrix \
    --pairs-per-batch 6 --batch-index "$batch" \
    --model openrouter/anthropic/claude-haiku-4.5 \
    --jev-model typesafe/jev-1.13 \
    --judge-model openrouter/google/gemini-3.8-flash --judge-rubric v2 \
    --max-cases 72 --max-judge-calls 144 --max-generations 24 \
    --timeout-ms 120000 --total-timeout-ms 10800000 \
    --opencode "$opencode" --secret-launcher "$secret_launcher" \
    --retain-private-review "$batch_dir/review" \
    > "$batch_dir/progress.jsonl" 2> "$batch_dir/runner.stderr"
  node - "$batch_dir/progress.jsonl" "$batch_dir/manifest.json" "$batch" <<'NODE'
const fs = require('node:fs');
try {
  const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
  const manifest = lines.at(-1);
  const batchIndex = Number(process.argv[4]);
  if (manifest?.kind !== 'conversation-routing-live-canary' ||
      manifest.studyBatch?.batchIndex !== batchIndex ||
      manifest.cases?.length !== 12 ||
      lines.filter((row) => row.event === 'pair-complete').length !== 6 ||
      lines.some((row) => row.event === 'case-failed')) throw Error();
  fs.writeFileSync(process.argv[3], JSON.stringify(manifest) + '\n', { mode: 0o600, flag: 'wx' });
} catch {
  process.stderr.write('Completed batch manifest was not verified.\n');
  process.exitCode = 1;
}
NODE
  manifest_args+=(--manifest "$batch_dir/manifest.json")
done
pnpm exec tsx scripts/conversation-routing-live-analysis.ts "${manifest_args[@]}" \
  > "$private_root/analysis.json"
```

Retain only final verified `manifest.json` files for aggregate analysis. The
analysis command uses six `--manifest` arguments and requires the same
plan, source, models, complete batch-index coverage, and nonoverlapping pair
IDs. It rejects incomplete or duplicate batches. If a batch stops after one
arm, its JSONL may contain earlier `pair-complete` records but has no final
manifest. Preserve that record as an interruption, inspect the closed failure
category, and resume later by rerunning that whole batch into a fresh private
directory after authorization; never assemble its partial progress as if the
missing arm ran. Each batch needs a distinct private review directory. A
private review pack may read all six directories by repeated directory
arguments; do not copy their raw text into the repository.

The seed fixes fixture and A/B order, not provider sampling or scheduling.
Generation-start counts are observed watchdogs, not strict provider-call
admission. The 144-call judge cap and three-hour timeout apply per batch;
six batches can cost and take substantially more. No strict dollar cap or
causal treatment claim follows from these settings.

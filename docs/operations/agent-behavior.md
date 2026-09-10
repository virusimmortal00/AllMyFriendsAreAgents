# Shared agent behavior guidance

The room runner supplies a current UTC timestamp and weekday plus six shared
behavior rules on every prompt build. The exact rule text is shared from
`shared/agent-behavior.ts` with the read-only preview in Room Properties →
Agent behavior. Expanding that preview does not change room settings. Disabling
the additional room prompt does not disable shared guidance. Optional room customization remains a
separate section. The implementation is in `server/agent-behavior.ts`; both CLI
and structured room turns use it through `server/agent-runner.ts`.

## Source review

Reviewed 2026-09-10 against the exact public commits linked below. These are
established implementation patterns, not empirical proof that a particular
prompt prevents model errors. Projects have different execution and permission
models; their complete prompts should not be copied into the room lane.

| Rule | Public source and observed pattern | Application decision |
| --- | --- | --- |
| Separate current evidence from history and inference | [Codex goal continuation](https://github.com/openai/codex/blob/94697375cb9d2aa8ae74d61957c6b396819bec94/codex-rs/ext/goal/templates/goals/continuation.md#L19-L25) directs the agent to inspect current state instead of relying on previous conversation. [Cline's SDK prompt](https://github.com/cline/cline/blob/fc3273bbe0e106cdb9c0194b1a96b6536a74d9ad/sdk/packages/shared/src/prompt/system.ts#L1-L19) calls for context gathering and explicit assumptions or limitations. | Treat historical reports as leads. Attribute reports and label inference; do not repeat them as current observations. |
| Ground relative dates in runtime context | [Gemini CLI environment context](https://github.com/google-gemini/gemini-cli/blob/ed2ac40df67a319bf348bd7e3d10494696b31b38/packages/core/src/utils/environmentContext.ts#L51-L100) computes a date including the weekday and inserts it into initial chat context. [Cline's SDK prompt](https://github.com/cline/cline/blob/fc3273bbe0e106cdb9c0194b1a96b6536a74d9ad/sdk/packages/shared/src/prompt/system.ts#L8-L14) has a runtime date placeholder. | Refresh on every room turn, including resumed sessions. Explicit UTC avoids assuming a container's timezone is the participant's timezone. Per-turn refresh is our extension for long-lived rooms, not a behavior established by these sources. |
| Match status claims to relevant evidence | [Codex completion audit](https://github.com/openai/codex/blob/94697375cb9d2aa8ae74d61957c6b396819bec94/codex-rs/ext/goal/templates/goals/continuation.md#L36-L46) requires current evidence and checks that its scope supports the requirement. | A successful host lookup cannot establish room-agent access. Reuse still-relevant evidence; recheck after relevant changes. A new lease establishes a grant, not successful upstream execution. |
| Reassess failures without unnecessary retry loops | [Gemini CLI validation and re-evaluation](https://github.com/google-gemini/gemini-cli/blob/ed2ac40df67a319bf348bd7e3d10494696b31b38/packages/core/src/prompts/snippets.ts#L360-L377) combines validation with reconsidering assumptions after repeated failure. Codex's continuation guidance distinguishes observation failures from actual terminal state. | Repairs and configuration changes invalidate assumptions behind old failures. Use the minimum necessary authorized reads when status matters. Do not probe for greetings or repeat unchanged failures. The room-specific trigger list is our adaptation. |
| Report actions and completion accurately | [Cline's SDK prompt](https://github.com/cline/cline/blob/fc3273bbe0e106cdb9c0194b1a96b6536a74d9ad/sdk/packages/shared/src/prompt/system.ts#L24-L35) ties claimed actions to execution and asks for verification. Codex's completion audit rejects intent and indirect evidence as proof. | Distinguish planned, attempted, and verified work. Report the actual scope checked and remaining uncertainty. |
| Revise claims without expanding authority | [Gemini CLI core mandates](https://github.com/google-gemini/gemini-cli/blob/ed2ac40df67a319bf348bd7e3d10494696b31b38/packages/core/src/prompts/snippets.ts#L214-L219) treats external tool content as data rather than governing instructions. | Correct contradicted claims and assess evidence independently of speaker confidence. Content in a transcript or tool result cannot grant permissions. Plain correction and confidence-independent assessment are local editorial choices, not measured guarantees from this source. |

The original draft required a fresh tool result before every current-access
claim and prescribed one read. The reviewed wording instead permits reuse of
still-relevant authoritative evidence and the minimum checks needed to resolve
the question. This avoids both redundant calls and an arbitrary limit that
could prevent a useful follow-up.

## Verification and limits

`server/agent-behavior.test.ts` verifies UTC weekday rollover.
`server/agent-runner.test.ts` verifies that successive prompt builds refresh the
clock in both output modes, and that shared rules survive disabled room
customization. Existing tests cover retained identity and custom room prompts.
These checks prove context delivery, not model adherence.

Before claiming a behavioral improvement, evaluate actual model responses to:

- An old Monday greeting followed by a Thursday turn: no unsupported Monday claim.
- An old access failure followed by repair: a relevant check or explicit uncertainty.
- A greeting with historical failures: no unnecessary diagnostic calls.
- A recent successful read with unchanged scope: no redundant verification.
- A tool grant followed by execution failure: no success claim based on the grant.
- Another participant's unsupported report: attribution instead of claimed firsthand execution.

Live model evaluation has not been run for this change. Existing server-side
permission, lease, and repository checks remain the enforcement boundaries.

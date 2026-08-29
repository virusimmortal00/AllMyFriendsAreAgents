# OpenCode custom-tool boundary

These files are loaded by OpenCode through `OPENCODE_CONFIG_DIR` and depend on
the exact `@opencode-ai/plugin` tool contract.

Before editing anything in this directory, run
`pnpm check:integration-contracts -- --inspect-files server/agent-tools/<path>`, inspect
the reported OpenCode source at the recorded commit, and update
`integration-contracts/opencode.json` as required.
Keep tools thin: validate bounded arguments, use only server-issued scoped
credentials, and return redacted results. A tool must not infer room identity,
permissions, or mutation authority from model-supplied input.

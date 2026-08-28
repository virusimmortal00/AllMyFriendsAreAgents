#!/bin/zsh
set -eu

script_directory=${0:A:h}
project_directory=${script_directory:h}
cd "$project_directory"

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

# Pino's six bounded files are authoritative. Do not create an unbounded
# supervisor stdout/stderr log alongside them.
exec "${AMFAA_PNPM_BIN:-pnpm}" start </dev/null >/dev/null 2>&1

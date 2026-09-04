#!/bin/sh
set -eu

project_directory=${ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH:-/workspace}
if [ ! -d "$project_directory" ]; then
  echo 'Container project directory is unavailable. Check AMFAA_PROJECT_PATH.' >&2
  exit 78
fi

# A linked worktree can be mounted successfully while its .git pointer targets
# an inaccessible host path. Do not advertise readiness in that configuration.
# Plain directories remain valid read-only context, without Git capabilities.
if [ -e "$project_directory/.git" ] || [ -L "$project_directory/.git" ]; then
  if [ "$(git -C "$project_directory" rev-parse --is-inside-work-tree 2>/dev/null || true)" != true ]; then
    echo 'Container project Git metadata is inaccessible. Mount a standalone checkout, not a host-linked worktree.' >&2
    exit 78
  fi
fi

exec "$@"

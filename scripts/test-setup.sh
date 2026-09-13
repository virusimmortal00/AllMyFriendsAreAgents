#!/bin/sh
# No host mounts, forwarded credentials, persistent volumes, or Compose services.
set -eu
cd "$(dirname "$0")/.."
case "${1:-}" in
  --build-only) build_only=1; shift ;;
  *) build_only=0 ;;
esac
image=amfaa-setup-sandbox:local
container="amfaa-setup-sandbox-$$"
recipe=$(mktemp)
cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  rm -f "$recipe"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
cat Dockerfile scripts/setup-sandbox.dockerfile > "$recipe"
docker build --target setup-sandbox --build-arg "APPLICATION_COMMIT=$(git rev-parse HEAD)" -t "$image" -f "$recipe" .
[ "$build_only" = 0 ] || exit 0
printf '\nDisposable setup sandbox. All saved keys and rooms disappear on exit.\nTo exit at any point, press Ctrl+P then Ctrl+Q.\nFor browser sign-in, choose Use another browser (SSH).\nAfter launch, open http://127.0.0.1:54147 in your browser.\n\n'
# Fail on port conflicts instead of reusing a development service.
docker run --rm --init -it --name "$container" \
  --label amfaa.setup-sandbox=true \
  --publish 127.0.0.1:54147:54147 \
  --env ALL_MY_FRIENDS_ARE_AGENTS_PORT=54147 \
  --env ALL_MY_FRIENDS_ARE_AGENTS_HOST=0.0.0.0 \
  --env ALL_MY_FRIENDS_ARE_AGENTS_ALLOW_UNAUTHENTICATED_REMOTE=true \
  "$image" "$@"

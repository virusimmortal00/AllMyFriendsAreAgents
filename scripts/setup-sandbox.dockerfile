# Appended to the canonical Dockerfile by test-setup.sh to reuse its pinned builds.
FROM node:24.5.0-bookworm-slim@sha256:ac365b72b69807f4b0f73bcddccffbed7307cc6e296fddf778f3c6ffd6be2381 AS setup-node

FROM build AS setup-package
ARG APPLICATION_COMMIT
COPY --from=setup-node /usr/local/bin/node /tmp/native-node
COPY --from=opencode-build /out/opencode /tmp/native-opencode
RUN pnpm exec tsx scripts/prepare-native-application.ts /tmp/production-app \
 && APPLICATION_COMMIT="$APPLICATION_COMMIT" pnpm exec tsx scripts/package-setup-sandbox.ts

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS setup-sandbox
RUN apt-get update && apt-get install --no-install-recommends --yes ca-certificates git procps \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 tester \
 && mkdir /workspace && chown tester:tester /workspace
COPY --from=setup-package /tmp/setup-install/ /opt/amfaa/
COPY scripts/setup-sandbox-entrypoint.sh /usr/local/bin/setup-sandbox-entrypoint
ENV ALL_MY_FRIENDS_ARE_AGENTS_SETUP_SANDBOX=1
ENV HOME=/home/tester TERM=xterm-256color COLORTERM=truecolor PATH=/opt/amfaa:/usr/local/bin:/usr/bin:/bin
USER tester
WORKDIR /workspace
ENTRYPOINT ["/bin/sh", "/usr/local/bin/setup-sandbox-entrypoint"]

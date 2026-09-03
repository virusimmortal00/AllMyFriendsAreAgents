# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS opencode-build
ARG TARGETARCH
ARG OPENCODE_REPOSITORY=https://github.com/virusimmortal00/opencode.git
ARG OPENCODE_COMMIT=6883ca5bd35a5494fb2759018373308911c79e01
ARG OPENCODE_VERSION=1.18.25-amfaa.2
RUN apt-get update \
  && apt-get install --no-install-recommends --yes build-essential ca-certificates git python3 \
  && rm -rf /var/lib/apt/lists/*
RUN git init /src \
  && git -C /src remote add origin "$OPENCODE_REPOSITORY" \
  && git -C /src fetch --depth 1 origin "$OPENCODE_COMMIT" \
  && git -C /src checkout --detach FETCH_HEAD \
  && test "$(git -C /src rev-parse HEAD)" = "$OPENCODE_COMMIT"
WORKDIR /src
RUN HUSKY=0 bun install --frozen-lockfile
RUN OPENCODE_CHANNEL=latest OPENCODE_VERSION="$OPENCODE_VERSION" \
    bun run packages/opencode/script/build.ts --single --skip-install --skip-embed-web-ui \
  && case "$TARGETARCH" in \
       amd64) binary=packages/opencode/dist/opencode-linux-x64/bin/opencode ;; \
       arm64) binary=packages/opencode/dist/opencode-linux-arm64/bin/opencode ;; \
       *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
     esac \
  && install -D --mode=0755 "$binary" /out/opencode \
  && test "$(/out/opencode --version)" = "$OPENCODE_VERSION"

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
ARG VCS_REF=unknown
ARG OPENCODE_REPOSITORY=https://github.com/virusimmortal00/opencode.git
ARG OPENCODE_COMMIT=6883ca5bd35a5494fb2759018373308911c79e01
ARG OPENCODE_VERSION=1.18.25-amfaa.2
LABEL org.opencontainers.image.title="All My Friends Are Agents" \
      org.opencontainers.image.description="Local-first multi-agent room server" \
      org.opencontainers.image.source="https://github.com/virusimmortal00/AllMyFriendsAreAgents" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.licenses="MIT" \
      io.allmyfriendsareagents.opencode.repository="$OPENCODE_REPOSITORY" \
      io.allmyfriendsareagents.opencode.revision="$OPENCODE_COMMIT" \
      io.allmyfriendsareagents.opencode.version="$OPENCODE_VERSION"

ENV NODE_ENV=production \
    ALL_MY_FRIENDS_ARE_AGENTS_PORT=53147 \
    ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND=/usr/local/bin/opencode

RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates git procps \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory /workspace \
  && mkdir -p /data /worktrees /workspace \
       /home/node/.allmyfriendsareagents /home/node/.cache \
       /home/node/.config/opencode /home/node/.local/share/opencode \
  && chown -R node:node /data /worktrees /workspace /home/node

WORKDIR /app
COPY --from=opencode-build /out/opencode /usr/local/bin/opencode
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/config ./config
COPY --from=build --chown=node:node /app/dist ./dist
COPY scripts/container-entrypoint.sh /usr/local/bin/amfaa-entrypoint

USER node
EXPOSE 53147
VOLUME ["/data", "/worktrees", "/home/node/.allmyfriendsareagents", "/home/node/.cache", "/home/node/.config/opencode", "/home/node/.local/share/opencode"]
ENTRYPOINT ["/bin/sh", "/usr/local/bin/amfaa-entrypoint"]
CMD ["./node_modules/.bin/tsx", "server/index.ts"]

# Full regression tests need source fixtures and the Linux confinement backend.
# Neither the extra test source nor bubblewrap is added to the default image.
FROM runtime AS test
USER root
RUN apt-get update \
  && apt-get install --no-install-recommends --yes bubblewrap \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/ /app/
USER node
ENV NODE_ENV=test
ENTRYPOINT ["/app/node_modules/.bin/vitest"]
CMD ["run"]

FROM runtime AS final

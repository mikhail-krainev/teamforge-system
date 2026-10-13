# syntax=docker/dockerfile:1
# Image of the resume sandbox (architecture 13.15, SEC-01). Build context: repository root.
# Same sources and dependency tree as docker/api.Dockerfile, but the runtime stage differs: no secrets
# in the image, no database or S3 access, and the parser child runs as uid 10002.
#
# Prototype result (S2-10): a non-root parent (user 10001) cannot start the child under another uid
# in Docker: `cap_add` puts SETUID/SETGID into the bounding set only, the effective set stays empty
# (spawn EPERM). So the parent runs as root with ALL capabilities dropped except SETUID and SETGID
# (docker-compose.yml); the child switches to 10002 and has no capabilities, cannot read the
# environment of the parent (other uid, no ptrace) and cannot write anywhere (read-only root).

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS base
ENV PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store \
    CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter api run build \
 && pnpm --filter api deploy --prod --legacy /out

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
ENV NODE_ENV=production \
    RESUME_CHILD_UID=10002 \
    RESUME_CHILD_GID=10002
# The child (parses a file, owns nothing): no shell, no home directory.
RUN addgroup -g 10002 parser && adduser -D -H -u 10002 -G parser -s /sbin/nologin parser
WORKDIR /app
# Root-owned, world-readable, never writable by the child.
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./package.json
CMD ["node", "dist/resume-worker/main.js"]

# syntax=docker/dockerfile:1
# Image of apps/api; the same image runs the api, the worker and the one-shot migrate job (command differs).
# Build context: repository root.

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS base
ENV PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store \
    CI=true
RUN corepack enable
WORKDIR /repo

# 1. Dependencies: only manifests and the lockfile, so source changes do not invalidate this layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# 2. Build: TypeScript -> apps/api/dist, then a production-only dependency tree.
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter api run build \
 && pnpm --filter api deploy --prod --legacy /out

# 3. Runtime: no sources, no dev dependencies, non-root user.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/drizzle ./drizzle
COPY --chown=node:node apps/api/package.json ./package.json
COPY --chown=node:node docker/worker-healthcheck.mjs ./healthcheck.mjs
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]

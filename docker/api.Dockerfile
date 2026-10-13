# syntax=docker/dockerfile:1
# Image of apps/api; the same image runs the api, the worker and the one-shot migrate job (command differs).
# Build context: repository root.

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS base
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
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/drizzle ./drizzle
COPY --from=build --chown=node:node /repo/apps/api/seeds ./seeds
COPY --chown=node:node apps/api/package.json ./package.json
COPY --chown=node:node docker/worker-healthcheck.mjs ./healthcheck.mjs
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]

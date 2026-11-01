# syntax=docker/dockerfile:1
# One image for the whole app: the Hono server answers /api and serves the built web app.

FROM node:24.22.1-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps

# Vite inlines VITE_* into the bundle at build time. Build a mainnet image with --build-arg VITE_ARC_NETWORK=mainnet
# (and run it with ARC_NETWORK=mainnet so the server matches).
ARG VITE_ARC_NETWORK=testnet
ENV VITE_ARC_NETWORK=$VITE_ARC_NETWORK
RUN npm run build -w apps/web

# Bundle the server (and @nilo/core, which ships TypeScript sources) into one file so the runtime needs no node_modules.
RUN npx esbuild apps/server/src/index.ts --bundle --platform=node --format=esm --target=node24 \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=dist/server.mjs

FROM node:24.22.1-slim
WORKDIR /app
# DATA_DIR: the investing agent's activity log; mount a volume here to keep it across deploys.
# Set ARC_NETWORK (testnet by default), NILO_OPERATOR_KEY and OPENAI_API_KEY at runtime.
ENV NODE_ENV=production \
    PORT=5173 \
    STATIC_DIR=public \
    DATA_DIR=/app/data

COPY --from=build /app/dist/server.mjs ./server.mjs
COPY --from=build /app/apps/web/dist ./public
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 5173
CMD ["node", "server.mjs"]

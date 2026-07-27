# Single image shared by the api, bot and worker services. The service being run
# is selected with the container `command`, which keeps the build cache warm and
# guarantees all three processes run identical business logic.
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache dumb-init

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/logging/package.json ./packages/logging/
COPY packages/validation/package.json ./packages/validation/
COPY packages/database/package.json ./packages/database/
COPY packages/authorization/package.json ./packages/authorization/
COPY packages/discord/package.json ./packages/discord/
COPY packages/reconciliation/package.json ./packages/reconciliation/
COPY packages/queue/package.json ./packages/queue/
COPY packages/core/package.json ./packages/core/
COPY apps/api/package.json ./apps/api/
COPY apps/bot/package.json ./apps/bot/
COPY apps/worker/package.json ./apps/worker/
RUN npm ci --omit=dev --no-audit --no-fund

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY packages ./packages
COPY apps ./apps

# Generate the Prisma client for the runtime platform.
RUN npx prisma generate

# Never run as root.
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/src/index.js"]

# ─── Stage 1: builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ─── Stage 2: production ─────────────────────────────────────────────────────
FROM node:20-alpine AS production

ENV NODE_ENV=production

# wget used by ECS container health check
RUN apk add --no-cache wget

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

USER node

EXPOSE 1234

# Migrations run first; the `&&` means the app never starts against an
# un-migrated schema. run-migrations.js exits non-zero on failure, so a bad
# migration stops the container rather than serving broken queries.
CMD ["sh", "-c", "node dist/database/run-migrations.js && node dist/main"]

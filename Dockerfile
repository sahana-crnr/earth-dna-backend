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

CMD ["node", "dist/main"]

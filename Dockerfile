# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm ci

# Self-hosted email verification service (Go, AfterShip/email-verifier MIT).
FROM golang:1.25-bookworm AS verifier
WORKDIR /src/services/email-verifier
COPY services/email-verifier/go.mod services/email-verifier/go.sum ./
RUN go mod download
COPY services/email-verifier/ ./
RUN CGO_ENABLED=0 go build -o /out/email-verifier .

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/next-env.d.ts ./next-env.d.ts
# Verification service binary (loopback-only by default).
COPY --from=verifier /out/email-verifier /usr/local/bin/email-verifier
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx prisma/seed.ts && email-verifier & npm start & npx tsx scripts/worker.ts & npx tsx scripts/verification-worker.ts & wait"]
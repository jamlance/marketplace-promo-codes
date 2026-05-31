# Multi-stage build for Promo Code Manager.
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/promo-codes ./apps/promo-codes
RUN pnpm install --no-frozen-lockfile
WORKDIR /work/apps/promo-codes
RUN pnpm exec vite build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git
COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/promo-codes/package.json ./apps/promo-codes/package.json
COPY --from=builder /work/apps/promo-codes/node_modules ./apps/promo-codes/node_modules
COPY --from=builder /work/apps/promo-codes/dist ./apps/promo-codes/dist
COPY apps/promo-codes/server.js ./apps/promo-codes/server.js
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/promo-codes
CMD ["node", "server.js"]

# syntax=docker/dockerfile:1

# =============================================================================
#  Road Cruise API — production image (multi-stage, Alpine, non-root)
#  Build context = this folder (the server repo root). Data is written ONLY to
#  $DATA_DIR (/data) — mount a persistent volume there on Dokploy/Docker.
# =============================================================================

# ---- Stage 1: dependencies -------------------------------------------------
# The build toolchain lives ONLY here so the one native module (argon2) can
# compile. It is discarded — the final image ships no compilers.
FROM node:24-alpine AS deps
WORKDIR /app

RUN apk add --no-cache python3 make g++

# Reproducible install from the lockfile. optionalDependencies (razorpay,
# nodemailer, argon2, …) are kept; devDependencies (nodemon) are omitted.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force

# ---- Stage 2: runtime ------------------------------------------------------
# Lean Alpine image: Node + installed deps + app source. No build tools.
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=5000 \
    DATA_DIR=/data

# Compiled + installed dependencies from the deps stage.
COPY --from=deps /app/node_modules ./node_modules
# App code (runtime data, tests, secrets are excluded via .dockerignore).
COPY package.json package-lock.json ./
COPY src ./src

# Persistent-data mountpoint, owned by the non-root `node` user that ships in
# the official image. A fresh Docker/Dokploy *named volume* inherits this
# ownership on first mount, so the app can write to it without running as root.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 5000

# Liveness probe — hits a public, dependency-free endpoint (busybox wget ships
# with Alpine). Marks the container unhealthy if the API stops responding.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/api/payments/config >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]

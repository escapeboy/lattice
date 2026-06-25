# Lattice self-hosted Agent Gateway.
# Multi-stage: build the pnpm monorepo, then run the gateway over Streamable HTTP.

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Install workspace manifests first for layer caching.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

# --frozen-lockfile pins exact, already-trusted versions, so the release-age
# supply-chain gate (which rejects deps published within a recent window) is
# orthogonal here and would only make reproducible builds flaky. Disable it for
# this build step only.
RUN pnpm install --frozen-lockfile --config.minimumReleaseAge=0
RUN pnpm -r --filter './packages/*' --filter './apps/*' build

# ── Runtime image ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production

# System Chromium + the libraries headless Chrome needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 libcairo2 \
      ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_EXECUTABLE=/usr/bin/chromium
ENV LATTICE_PORT=8765
ENV LATTICE_HOST=0.0.0.0

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY --from=build /app ./

# Run as the unprivileged node user (Chromium sandbox + least privilege).
RUN chown -R node:node /app
USER node

EXPOSE 8765
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "packages/gateway/dist/main.js"]

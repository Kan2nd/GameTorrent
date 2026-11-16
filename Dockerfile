# node:20-alpine (musl libc) segfaults once real uTP traffic flows: webtorrent's
# utp-native dependency ships prebuilt native addons compiled for glibc, which
# load fine on Alpine but crash on first real use (found via an actual VM
# download test, not caught by any syntax/unit-level check). node:20-bookworm-slim
# is glibc-based (Debian), still much smaller than the full node:20 image.
# Pinned by digest — see webui/Dockerfile.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

WORKDIR /app

RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*

COPY poc/package.json poc/package-lock.json ./poc/
RUN cd poc && npm ci --omit=dev \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# pipeline.js was missing here: poc.js requires it, so this image used to crash on start with
# "Cannot find module './pipeline'" (never noticed because CI never built it — see log/H1).
COPY poc/poc.js poc/pipeline.js ./poc/
COPY catalog ./catalog
COPY config ./config

# Unprivileged user; only the two output folders are writable.
RUN mkdir -p /app/downloads /app/roms && chown node:node /app/downloads /app/roms
USER node

ENTRYPOINT ["node", "poc/poc.js"]
CMD ["--help"]

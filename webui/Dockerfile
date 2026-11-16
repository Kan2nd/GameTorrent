# glibc base, not Alpine — see ../Dockerfile's comment: webtorrent's
# utp-native dependency segfaults on musl once real uTP traffic flows.
# Pinned by digest: the tag says what it is, the digest guarantees the exact bytes that were
# tested and scanned (a tag can move under you). Renovate/manual bumps update both together.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

WORKDIR /app

# ClamAV for the pipeline's malware-scan step. The signature DB is fetched at build time so the
# first scan works, then refreshed in the background on every container start (see ENTRYPOINT).
# `apt-get upgrade` pulls in Debian's security fixes that are newer than the pinned base image
# (Trivy found fixable CVEs in libgnutls30 / libpcre2 / libcap2 without it).
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends clamav ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/^NotifyClamd/#NotifyClamd/' /etc/clamav/freshclam.conf
# ca-certificates is required: the slim base image has none, and without it freshclam can't verify
# database.clamav.net's TLS cert, so the DB stays empty and every scan is skipped.
RUN freshclam || echo "freshclam failed at build time — will retry at container start"

COPY poc/package.json poc/package-lock.json ./poc/
RUN cd poc && npm ci --omit=dev

COPY webui/package.json webui/package-lock.json ./webui/
RUN cd webui && npm ci --omit=dev

# npm/npx/corepack are only needed for the installs above — the app never runs them. Removing them
# drops npm's own bundled dependencies (tar, glob, minimatch, sigstore, ...) from the final image,
# which is where every remaining Node-level CVE in the image scan lived.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY poc/pipeline.js ./poc/pipeline.js
COPY catalog ./catalog
COPY config ./config
COPY webui/server.js ./webui/server.js
COPY webui/lib ./webui/lib
COPY webui/db ./webui/db
COPY webui/public ./webui/public

# Run as the unprivileged `node` user (uid 1000, already in the base image) instead of root.
# It only gets write access to what it actually writes: the three data folders (named volumes in
# docker-compose.yml) and ClamAV's signature DB + log (so freshclam can still update as non-root).
# Everything else — including the app's own code — stays root-owned and read-only to it.
RUN mkdir -p /app/downloads /app/roms /app/webui/data \
    && chown -R node:node /app/downloads /app/roms /app/webui/data /var/lib/clamav /var/log/clamav
USER node

WORKDIR /app/webui
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["sh", "-c", "(freshclam --quiet || true) & exec node server.js"]

# glibc base, not Alpine — see ../Dockerfile's comment: webtorrent's
# utp-native dependency segfaults on musl once real uTP traffic flows.
FROM node:20-bookworm-slim

WORKDIR /app

# ClamAV for the pipeline's malware-scan step. The signature DB is fetched at build time so the
# first scan works, then refreshed in the background on every container start (see ENTRYPOINT).
RUN apt-get update \
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

COPY poc/pipeline.js ./poc/pipeline.js
COPY catalog ./catalog
COPY config ./config
COPY webui/server.js ./webui/server.js
COPY webui/lib ./webui/lib
COPY webui/public ./webui/public

WORKDIR /app/webui
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["sh", "-c", "(freshclam --quiet || true) & exec node server.js"]

# node:20-alpine (musl libc) segfaults once real uTP traffic flows: webtorrent's
# utp-native dependency ships prebuilt native addons compiled for glibc, which
# load fine on Alpine but crash on first real use (found via an actual VM
# download test, not caught by any syntax/unit-level check). node:20-bookworm-slim
# is glibc-based (Debian), still much smaller than the full node:20 image.
FROM node:20-bookworm-slim

WORKDIR /app

COPY poc/package.json poc/package-lock.json ./poc/
RUN cd poc && npm ci --omit=dev

COPY poc/poc.js ./poc/poc.js
COPY catalog ./catalog
COPY config ./config

ENTRYPOINT ["node", "poc/poc.js"]
CMD ["--help"]

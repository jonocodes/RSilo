# RSilo's offline server: SQLite plus a local directory, for local use and
# test suites (e.g. rclone's). Not for production; that runs on Cloudflare.
#
#   docker run -d -p 127.0.0.1:8787:8787 -v rsilo-data:/data ghcr.io/jonocodes/rsilo
#   docker exec <container> bun src/scripts/dev-token.ts alice '*:rw'   # prints a bearer token
#
# The server listens on 0.0.0.0 inside the container, which switches the dev
# identity off (see LISTEN_HOST in src/server-offline.ts): /account and /debug
# have no identity source, and storage works with dev-token bearer tokens.
# Publish the port on 127.0.0.1 all the same.
FROM oven/bun:1.3.14-slim

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY drizzle ./drizzle
COPY src ./src

ENV STORAGE_DIR=/data/storage \
    DB_PATH=/data/remotestorage.db \
    PORT=8787 \
    LISTEN_HOST=0.0.0.0
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
EXPOSE 8787
# The server shuts down cleanly (closing SQLite) on SIGINT
STOPSIGNAL SIGINT
USER bun

CMD ["bun", "src/server-offline.ts"]

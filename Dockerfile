# --- Build stage -----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install only what's needed for builds. We don't have native deps right now,
# but lowdb uses dynamic imports that some environments tree-shake oddly —
# pulling in the full dev install keeps astro check happy.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Type check + build. AUTH_SECRET is only needed at runtime, not build time.
# `npm run build`, not the astro commands by hand: it also compiles the mail
# test into dist/mail-test.mjs, and this image has no src/ to compile it from
# later (`docker compose exec app node dist/mail-test.mjs you@example.com`).
RUN npm run build

# Drop dev deps for the runtime stage.
RUN npm prune --omit=dev

# --- Runtime stage ---------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
# Keep mutable state outside the image layer so redeploys don't reset data.
# /app/data is a volume; the database, uploads and form attachments all live
# there. Everything the app writes has to be listed here: a path left at its
# code default lands in /app, in the container's own layer, and disappears the
# next time the container is recreated.
ENV DB_PATH=/app/data/db.json
ENV UPLOADS_DIR=/app/data/uploads
# Files strangers attach to public forms. Its code default used to be
# /app/private-uploads — outside the volume — so every attachment was lost on
# `docker compose up --build`. Kept out of UPLOADS_DIR, which is public.
ENV PRIVATE_UPLOADS_DIR=/app/data/private-uploads
# Graceful shutdown budget (src/lib/shutdown.ts). `docker stop` sends SIGTERM
# and follows with SIGKILL after 10 s by default, so the drain has to finish
# inside that. docker-compose.yml raises both (stop_grace_period).
ENV SHUTDOWN_TIMEOUT_MS=8000

# Non-root user with write access to the volume mounts.
RUN addgroup -S app && adduser -S -G app app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# No db.seed.json. This line used to copy one, the project stopped shipping it
# (src/lib/localdb.ts explains why), and every `docker build` on a clean clone
# failed here. The seed is optional and read only if present; mount one into
# /app to use it.
COPY --from=build /app/package.json ./package.json
# The licence and notices travel with the image: it bundles libvips (LGPL-3.0,
# via sharp), and THIRD-PARTY-NOTICES.md makes keeping its notice and written
# offer with any such distribution a condition. One file per line so
# tests/deploy-artifacts.test.mjs checks each exists.
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/NOTICE ./NOTICE
COPY --from=build /app/THIRD-PARTY-NOTICES.md ./THIRD-PARTY-NOTICES.md

# Create the data dirs (mount a volume here) and make everything writable.
# private-uploads is 0750: nothing but the app has any business reading it.
RUN mkdir -p /app/data/uploads /app/data/private-uploads \
  && chmod 0750 /app/data/private-uploads \
  && chown -R app:app /app
USER app

# Persist database + uploads across container restarts/redeploys.
VOLUME ["/app/data"]
EXPOSE 4321
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4321/healthz >/dev/null 2>&1 || exit 1
# Astro standalone Node adapter entrypoint.
CMD ["node", "./dist/server/entry.mjs"]

# syntax=docker/dockerfile:1
# --- Stage 1: Build (deps + compile) ---
FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY . .
RUN bun build --compile --minify --target=bun --outfile=ytdl ./server.ts

# --- Stage 2: Runtime ---
FROM oven/bun:1-slim AS runner
WORKDIR /app

# ffmpeg (system package)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends ffmpeg

# uv + yt-dlp with curl-cffi
COPY --from=ghcr.io/astral-sh/uv:0.10 /uv /usr/local/bin/uv
ENV UV_TOOL_BIN_DIR=/usr/local/bin
RUN --mount=type=cache,target=/root/.cache/uv \
    uv tool install 'yt-dlp[default,curl_cffi]'

# App: single binary + static assets
COPY --from=build /app/ytdl /app/ytdl
COPY --from=build /app/public ./public

ENV NODE_ENV=production
EXPOSE 3000
CMD ["./ytdl"]

# syntax=docker/dockerfile:1
ARG TARGETPLATFORM

FROM --platform=$TARGETPLATFORM ghcr.io/astral-sh/uv:0.10 AS uvbin

FROM --platform=$TARGETPLATFORM docker.io/denoland/deno:bin-2.7.3 AS denobin

# --- Stage 2: Runtime ---
FROM --platform=$TARGETPLATFORM docker.io/oven/bun:1-slim AS runner
WORKDIR /app

COPY package.json bun.lock* bunfig.toml ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json server.ts ./
COPY public ./public
COPY src ./src

# ffmpeg (system package)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# uv + yt-dlp with curl-cffi (yt-dlp[default] includes yt-dlp-ejs scripts)
COPY --from=uvbin /uv /usr/local/bin/uv
ENV UV_TOOL_BIN_DIR=/usr/local/bin
RUN --mount=type=cache,target=/root/.cache/uv \
    uv tool install 'yt-dlp[default,curl_cffi]'

# Deno JS runtime for yt-dlp EJS challenge solving (enabled by default)
COPY --from=denobin /deno /usr/local/bin/deno

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "server.ts"]

# syntax=docker/dockerfile:1
ARG BUILDPLATFORM
ARG TARGETARCH
ARG TARGETPLATFORM

# --- Stage 1: Build (deps + compile) ---
FROM --platform=$BUILDPLATFORM docker.io/oven/bun:1 AS build
ARG TARGETARCH
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY . .
RUN case "$TARGETARCH" in \
      arm64) export BUILD_TARGET="bun-linux-arm64" ;; \
      amd64) export BUILD_TARGET="bun-linux-x64" ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    bun run build

FROM --platform=$TARGETPLATFORM ghcr.io/astral-sh/uv:0.10 AS uvbin

FROM --platform=$TARGETPLATFORM docker.io/denoland/deno:bin-2.7.3 AS denobin

# --- Stage 2: Runtime ---
FROM --platform=$TARGETPLATFORM docker.io/library/debian:bookworm-slim AS runner
WORKDIR /app

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

# App: compiled binaries (frontend assets embedded in server via --compile)
COPY --from=build /app/dist/ytdl /app/ytdl
COPY --from=build /app/dist/ytdl-worker /app/ytdl-worker

ENV NODE_ENV=production
EXPOSE 3000
CMD ["./ytdl"]

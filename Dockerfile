# --- Stage 1: Dependencies ---
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Stage 2: Build ---
FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# --- Stage 3: Runtime ---
FROM node:20-slim AS runner
WORKDIR /app

# ffmpeg (system package -- no uv/pip alternative)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# uv + yt-dlp with curl-cffi (in a single isolated tool environment)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_TOOL_BIN_DIR=/usr/local/bin
RUN uv tool install 'yt-dlp[default,curl_cffi]'

# App
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/next.config.mjs ./

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]

# Stage 1: Install production dependencies
FROM node:20 AS dependencies

WORKDIR /app

RUN mkdir -p /app/bin
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /app/bin/yt-dlp
RUN chmod a+rx /app/bin/yt-dlp

# Copy only the package.json and package-lock.json
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --only=production

# Stage 2: Build the runtime image
FROM node:20 AS runner

WORKDIR /app

# Copy the built application and production dependencies
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/bin/yt-dlp ./bin/yt-dlp
COPY .next/ ./.next/
COPY next.config.mjs ./next.config.mjs
COPY package.json ./package.json

# Install remaining dependencies
RUN apt-get update && apt-get install -y ffmpeg

RUN curl -LsSf https://astral.sh/uv/install.sh | sh

ENV PATH=/root/.local/bin:$PATH
RUN uv venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
RUN uv pip install curl-cffi

ENV NODE_ENV production

EXPOSE 3000

CMD ["npm", "start"]

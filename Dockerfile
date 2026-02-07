FROM node:20

WORKDIR /app

RUN apt-get update && apt-get install -y ffmpeg wget \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/bin \
  && wget -q https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /app/bin/yt-dlp \
  && chmod a+rx /app/bin/yt-dlp

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH=/root/.local/bin:$PATH
RUN uv venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
RUN uv pip install curl-cffi

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]

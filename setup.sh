#!/bin/sh
set -e

# System packages
apt-get update
apt-get install -y ffmpeg wget
rm -rf /var/lib/apt/lists/*

# yt-dlp
mkdir -p /app/bin
wget -q https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /app/bin/yt-dlp
chmod a+rx /app/bin/yt-dlp

# uv + Python venv for curl-cffi
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="/root/.local/bin:$PATH"
uv venv /opt/venv
export PATH="/opt/venv/bin:$PATH"
uv pip install curl-cffi

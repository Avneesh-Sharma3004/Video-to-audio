FROM node:22-bookworm

WORKDIR /app

# System packages
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 \
       python3-pip \
       ffmpeg \
       curl \
       ca-certificates \
       git \
    && rm -rf /var/lib/apt/lists/*

# Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# yt-dlp
RUN python3 -m pip install --break-system-packages -U yt-dlp

# Verify yt-dlp
RUN yt-dlp --version

# Clone bgutil provider
RUN git clone --depth 1 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
    /opt/bgutil

# Install bgutil server dependencies
WORKDIR /opt/bgutil/server

RUN npm ci

# Build provider
RUN npx tsc

# Install yt-dlp plugin
RUN mkdir -p /root/yt-dlp-plugins/bgutil-ytdlp-pot-provider \
    && cp -r /opt/bgutil/plugin/* \
       /root/yt-dlp-plugins/bgutil-ytdlp-pot-provider/

# Back to application
WORKDIR /app

COPY . .

# Render will provide PORT
EXPOSE 10000

CMD ["sh", "-c", "node /opt/bgutil/server/build/main.js --host 127.0.0.1 --port 4416 & node server.js"]
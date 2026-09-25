FROM python:3.12-slim

WORKDIR /app

# Install Node.js
RUN apt-get update \
    && apt-get install -y curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip install --no-cache-dir yt-dlp

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

ENV NODE_ENV=production
ENV YTDLP_PATH=yt-dlp

CMD ["node", "server.js"]
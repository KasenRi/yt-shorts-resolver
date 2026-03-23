FROM node:22-bookworm-slim

WORKDIR /app

RUN unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
  && pip3 install --break-system-packages --no-cache-dir yt-dlp \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY \
  && npm ci --omit=dev

COPY src ./src
COPY tampermonkey ./tampermonkey
COPY scripts ./scripts

EXPOSE 8787

CMD ["node", "src/server.js"]

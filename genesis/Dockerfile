# Genesis agents image. Same as the upstream Dockerfile, except:
#   - starts through the Genesis launcher, which applies genesis/settings.json
#   - packages come from the committed lockfiles (npm ci), so none can move on unnoticed
#   - a second install, for the Redis and Postgres clients listed in genesis/package.json
#     (they land in /app/genesis/node_modules)
#   - the libstdc++ that the prebuilt canvas package brings is removed, so canvas uses the system's:
#     with the bundled one loaded first the prebuilt gl package cannot load ("GLIBCXX_3.4.29 not
#     found") and every agent process ends at its first import (src/agent/vision/camera.js)
# Build from the repository root:
#   docker build -f genesis/Dockerfile -t genesis-agents .
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python-is-python3 \
    python3-pip \
    xvfb \
    xauth \
    libgl1-mesa-dev \
    libgles2-mesa-dev \
    libosmesa6-dev \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libxi-dev \
    libxinerama-dev \
    libxrandr-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json .
COPY patches ./patches
RUN npm ci && rm -f node_modules/canvas/build/Release/libstdc++.so.6 \
    && node -e "require('node-canvas-webgl/lib/index.js')"

# Genesis-only packages (redis, pg): imported by genesis/adapters and by nothing else.
# npm ci installs exactly what the committed lockfiles name, so no package can move on unnoticed
COPY genesis/package.json genesis/package-lock.json ./genesis/
RUN npm ci --prefix genesis --omit=dev --no-audit --no-fund

# .dockerignore keeps a genesis/node_modules of the build machine out of this copy
COPY . .

CMD ["node", "genesis/start.js"]

# Genesis agents image. Same as the upstream Dockerfile, except:
#   - Node 20 LTS instead of Node 22
#   - starts through the Genesis launcher, which applies genesis/settings.json
#   - a second npm install, for the Redis and Postgres clients listed in genesis/package.json
#     (they land in /app/genesis/node_modules; the root package.json is upstream's, untouched)
# Build from the repository root:
#   docker build -f genesis/Dockerfile -t genesis-agents .
FROM node:20-bookworm-slim

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
RUN npm install

# Genesis-only packages (redis, pg): imported by genesis/adapters and by nothing else.
COPY genesis/package.json ./genesis/package.json
RUN npm install --prefix genesis --omit=dev --no-audit --no-fund

# .dockerignore keeps a genesis/node_modules of the build machine out of this copy
COPY . .

CMD ["node", "genesis/start.js"]

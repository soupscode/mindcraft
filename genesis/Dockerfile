# Genesis agents image. Same as the upstream Dockerfile, except:
#   - Node 20 LTS instead of Node 22
#   - starts through the Genesis launcher, which applies genesis/settings.json
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

COPY . .

CMD ["node", "genesis/start.js"]

# Genesis alerter image (Node 20). Build from the repository root, because the event
# contract (genesis/shared/events.js) is used as it is and lives outside this folder:
#   docker build -f genesis/alerter/Dockerfile -t genesis-alerter .
# genesis/alerter/Dockerfile.dockerignore keeps everything else out of the build context.

FROM node:20-bookworm-slim AS build
WORKDIR /app/genesis/alerter
COPY genesis/alerter/package.json ./
RUN npm install --no-audit --no-fund
COPY genesis/shared /app/genesis/shared
COPY genesis/alerter/tsconfig.json ./
COPY genesis/alerter/scripts/build.mjs ./scripts/build.mjs
COPY genesis/alerter/src ./src
RUN npm run build

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY genesis/alerter/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/genesis/alerter/dist ./dist
COPY genesis/alerter/migrations ./migrations
USER node
CMD ["node", "dist/alerter.mjs"]

# Genesis dashboard image (Node 20). Build from the repository root, because the event
# contract (genesis/shared/events.js) is used as it is and lives outside this folder:
#   docker build -f genesis/dashboard/Dockerfile -t genesis-dashboard .
# genesis/dashboard/Dockerfile.dockerignore keeps everything else out of the build context.

FROM node:20-bookworm-slim AS build
WORKDIR /app/genesis/dashboard
COPY genesis/dashboard/package.json ./
RUN npm install --no-audit --no-fund
COPY genesis/shared /app/genesis/shared
COPY genesis/dashboard/tsconfig.json ./
COPY genesis/dashboard/scripts/build.mjs ./scripts/build.mjs
COPY genesis/dashboard/src ./src
RUN npm run build

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY genesis/dashboard/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/genesis/dashboard/dist ./dist
COPY genesis/dashboard/migrations ./migrations
USER node
EXPOSE 8080
CMD ["node", "dist/server.mjs"]

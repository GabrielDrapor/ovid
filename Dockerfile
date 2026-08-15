# Self-hosted Ovid: SPA + API in one container.
# node:sqlite (built in) means no native modules to compile.
FROM node:22-slim AS build

WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000

COPY tsconfig.json ./
COPY public/ ./public/
COPY src/ ./src/
COPY database/ ./database/

# React SPA
RUN SKIP_PREFLIGHT_CHECK=true CI=false yarn build
# Server bundle (esbuild; Workflows backend stubbed out for self-hosting)
RUN yarn build:server

FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    OVID_DATA_DIR=/data \
    OVID_BUILD_DIR=/app/build \
    OVID_PORT=8080

COPY --from=build /app/build ./build
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/database ./database

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:8080/api/v2/books').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/server.mjs"]

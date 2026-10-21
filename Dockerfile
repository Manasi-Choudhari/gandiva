# Backend only: the Hono API (registry, sellers, buyer agent, ledger). The Next.js UI deploys separately (Vercel).
FROM node:24-bookworm-slim AS build

# better-sqlite3 has no prebuilt binary for this Node version, so it compiles from source. None of this reaches the final image.
RUN apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim

# Litestream copies data/gandiva.db to a bucket and restores it on boot, so the free Render plan (no disk) keeps its data.
COPY --from=litestream/litestream:0.3.13 /usr/local/bin/litestream /usr/local/bin/litestream
# Litestream reaches the bucket over TLS and reads the system's certificates (Node has its own); the slim image has none.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# src/stake reads contracts/SellerStakeV2.json at startup
COPY contracts ./contracts
COPY deploy/litestream.yml ./litestream.yml
# Strip Windows line endings so the script runs on Linux whatever the checkout settings were.
COPY deploy/start.sh /usr/local/bin/start.sh
RUN sed -i 's/\r$//' /usr/local/bin/start.sh && chmod +x /usr/local/bin/start.sh

ENV NODE_ENV=production \
    PORT=10000 \
    DB_PATH=/app/data/gandiva.db
RUN mkdir -p /app/data/sellers && chown -R node:node /app/data

# The code stays owned by root, so the server can write to its data folder and nothing else.
USER node

EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["start.sh"]

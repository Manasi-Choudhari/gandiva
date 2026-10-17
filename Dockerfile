# Backend only: the Hono API (registry, sellers, buyer agent, ledger). The Next.js UI deploys separately (Vercel).
FROM node:24-bookworm-slim

# better-sqlite3 has no prebuilt binary for this Node version, so it compiles from source.
RUN apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Full install: the server runs through tsx, which is a devDependency.
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# src/stake reads contracts/SellerStake.json at startup
COPY contracts ./contracts

ENV NODE_ENV=production \
    PORT=10000 \
    DB_PATH=/app/data/gandiva.db
RUN mkdir -p /app/data/sellers

EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/server.ts"]

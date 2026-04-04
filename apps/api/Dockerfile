FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY package-lock.json ./
RUN npm install --include=dev --no-audit --no-fund

COPY apps ./apps
COPY packages ./packages
COPY wrappers ./wrappers
COPY scripts ./scripts
COPY contracts ./contracts
COPY tsconfig.json ./
COPY .env.example ./
RUN npx blueprint build TonForecastMarket

CMD ["node", "apps/api/src/index.js"]

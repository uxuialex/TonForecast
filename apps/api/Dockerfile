FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json ./
COPY package-lock.json ./
RUN npm install --include=dev

COPY apps ./apps
COPY packages ./packages
COPY wrappers ./wrappers
COPY scripts ./scripts
COPY contracts ./contracts
COPY tsconfig.json ./
COPY .env.example ./
RUN npx blueprint build TonForecastMarket

CMD ["node", "apps/api/src/index.js"]

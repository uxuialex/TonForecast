FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --include=dev

COPY apps ./apps
COPY packages ./packages
COPY wrappers ./wrappers
COPY scripts ./scripts
COPY contracts ./contracts
COPY build ./build
COPY tsconfig.json ./
COPY .env.example ./

CMD ["node", "apps/api/src/index.js"]

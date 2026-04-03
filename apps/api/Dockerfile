FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --include=dev

CMD ["node", "apps/api/src/index.js"]

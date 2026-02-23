FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

RUN npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]

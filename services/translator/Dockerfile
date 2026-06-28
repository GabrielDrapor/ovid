FROM node:22-slim

# Fonts for Sharp/librsvg text rendering on covers & spines.
# Noto Serif (Latin) + Noto Serif CJK (Chinese/Japanese/Korean) so titles in any
# language render instead of tofu boxes. fontconfig is required for matching.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-core fonts-noto-cjk fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

RUN npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]

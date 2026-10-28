FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
# @tapekit/kernel is vendored as a git submodule (file: dependency of the CLI); the web app is not needed in the API image.
RUN npm ci && npm run build:libs && npm prune --omit=dev
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/tapesynth.db
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]

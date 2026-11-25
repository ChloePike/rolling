# FFmpeg renderer for Cloudflare Containers (class FfmpegRenderer in apps/api).
# Build context: this directory. Runs the tiny HTTP server on port 8080.
# Fonts: captions burn in with libass (`ass` filter) in DejaVu Sans.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core fontconfig \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src/*.ts ./src/

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
# Node 22.18+ runs .ts files directly via type stripping.
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server.ts"]

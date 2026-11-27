# FFmpeg renderer for Cloudflare Containers (class FfmpegRenderer in apps/api).
# Build context: this directory. Runs the tiny HTTP server on port 8080.
# Fonts (all SIL Open Font License, D-026): captions burn in with libass
# (`ass` filter) and cards draw with `drawtext`. Noto Sans covers Latin,
# Cyrillic, Greek, Thai, Vietnamese and more (fonts-noto-core); Noto Sans CJK
# covers Japanese, Korean and Chinese in regional variants (fonts-noto-cjk);
# DejaVu Sans stays as the last fallback. Brand fonts arrive per job.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates fontconfig fonts-dejavu-core fonts-noto-core fonts-noto-cjk \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src/*.ts ./src/

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
# Node 22.18+ runs .ts files directly via type stripping.
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server.ts"]

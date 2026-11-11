# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    MM_CACHE_DIR=/app/cache \
    MM_TAG_PAGES=3 \
    MM_TAG_TIMEOUT=3000 \
    MM_CATALOG_TTL=43200000

COPY package.json ./
# все адаптеры и общая логика: раньше здесь был только список из трёх файлов и образ не работал
COPY *.js ./
COPY demo.html README.md ./

RUN mkdir -p /app/cache
VOLUME ["/app/cache"]

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health >/dev/null || exit 1

CMD ["node", "server.js"]

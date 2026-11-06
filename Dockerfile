# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# без зависимостей: только исходники и демо
COPY package.json ./
COPY server.js registry.js http.js mm.js moody.js nudemoon.js ./
COPY demo.html README.md ./

# кэш каталога переживает рестарты контейнера, если подключить volume на /app/cache
RUN mkdir -p /app/cache && chmod 777 /app/cache
VOLUME ["/app/cache"]

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health >/dev/null || exit 1

CMD ["node", "server.js"]

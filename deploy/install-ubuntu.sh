#!/usr/bin/env bash
# Установка манга-сервера на Ubuntu 22.04/24.04 (Oracle Cloud Always Free, любой VPS).
# Запуск от root:  bash install-ubuntu.sh tikenmanga.duckdns.org
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "нужен домен: bash install-ubuntu.sh <домен>"; exit 1
fi

echo "== пакеты"
apt-get update -y
apt-get install -y curl ca-certificates gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https

echo "== Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== пользователь и каталог"
id -u manga >/dev/null 2>&1 || useradd -r -m -d /opt/manga -s /usr/sbin/nologin manga
mkdir -p /opt/manga/cache
chown -R manga:manga /opt/manga

echo "== исходники"
# локально уже есть каталог manga-api — копируем его содержимое
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cp -f "$SRC"/*.js "$SRC"/demo.html "$SRC"/package.json "$SRC"/README.md /opt/manga/ 2>/dev/null || true
chown -R manga:manga /opt/manga

echo "== systemd"
cp -f "$SRC/deploy/systemd/manga-api.service" /etc/systemd/system/manga-api.service
systemctl daemon-reload
systemctl enable --now manga-api

echo "== Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
sed "s/tikenmanga.duckdns.org/$DOMAIN/g" "$SRC/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl restart caddy

echo "== файрвол"
ufw allow 22/tcp || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw --force enable || true

echo "== проверка"
sleep 3
curl -fsS "http://127.0.0.1:3001/health" | head -c 200; echo
echo "готово: https://$DOMAIN/demo"

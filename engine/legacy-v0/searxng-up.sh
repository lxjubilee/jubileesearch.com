#!/usr/bin/env bash
# Start (or restart) the SearXNG container JubileeSearch uses for web-wide results.
#
# The config is COPIED IN rather than bind-mounted on purpose: Docker Desktop
# cannot share the W: drive, and a bind mount to it silently mounts empty — the
# container then writes its own default settings.yml and the JSON API answers
# 403. Copying is reproducible and drive-independent.
set -euo pipefail

NAME=jubileesearch-searxng
PORT=${PORT:-8088}
HERE="$(cd "$(dirname "$0")/.." && pwd)"

docker rm -f "$NAME" >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker run -d --name "$NAME" --restart unless-stopped \
  -p "${PORT}:8080" -e "SEARXNG_BASE_URL=http://localhost:${PORT}/" \
  searxng/searxng:latest >/dev/null

MSYS_NO_PATHCONV=1 docker cp "$HERE/searxng/settings.yml" "$NAME:/etc/searxng/settings.yml"
MSYS_NO_PATHCONV=1 docker exec -u root "$NAME" chown searxng:searxng /etc/searxng/settings.yml
docker restart "$NAME" >/dev/null

for i in $(seq 1 15); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/")" = "200" ] && break
  sleep 2
done

code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/search?q=test&format=json")
if [ "$code" = "200" ]; then
  echo "SearXNG up on :${PORT} — JSON API OK"
else
  echo "SearXNG up on :${PORT} but JSON returned $code (check search.formats in settings.yml)" >&2
  exit 1
fi

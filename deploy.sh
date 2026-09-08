#!/usr/bin/env bash
# deploy.sh — push the static JubileeSearch.com site to production.
#
# The production host and web root are NOT stored in this repo. Supply them
# per-run, or put them in deploy.env beside this script (gitignored):
#
#     REMOTE=root@your.host REMOTE_DIR=/var/www/.../www bash deploy.sh
#
#     # deploy.env
#     REMOTE=root@your.host
#     REMOTE_DIR=/var/www/.../www
#
# VERIFIED 2026-08-30 against the live host, and the notes below still hold:
#   * REMOTE_DIR must be the nginx `root` for the jubileesearch.com vhost. It
#     was confirmed by fetching the live index.html (3182 bytes) and matching
#     it byte-for-byte against the file there.
#
#     It is NOT the `cwd` from ops/config/websites-services.json — that path
#     does not exist on the box. The registry entry describes a Node service
#     on :3038 which is not running and is not in pm2; nginx serves the site
#     statically instead. Do not "fix" REMOTE_DIR to the registry path.
#   * Key: ~/.ssh/id_ed25519_jubilee_prod (override with SSH_KEY).
#
# NOT DEPLOYED: engine/ (the crawler + index backend) and .env. The web root
# also holds a src/ tree, package.json, web.config and an .env belonging to the
# dormant Node app; nothing here touches them.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Local, gitignored overrides. Keeps the production address out of the repo.
# shellcheck disable=SC1091
[ -f "$HERE/deploy.env" ] && . "$HERE/deploy.env"

REMOTE="${REMOTE:?set REMOTE (e.g. root@your.host), or put it in deploy.env}"
REMOTE_DIR="${REMOTE_DIR:?set REMOTE_DIR (the nginx root), or put it in deploy.env}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_jubilee_prod}"
SITE_URL="${SITE_URL:-https://www.jubileesearch.com}"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15)

[ -f "$SSH_KEY" ] || { echo "No SSH key at $SSH_KEY — cannot deploy."; exit 1; }

# Only the published static files. Never .env, never engine/, never server.cjs.
INCLUDE=(index.html search.html bot.html css js fonts images)

echo "→ Target: $REMOTE:$REMOTE_DIR"
"${SSH[@]}" "$REMOTE" "[ -d '$REMOTE_DIR' ]" \
  || { echo "Remote dir $REMOTE_DIR does not exist — refusing to deploy."; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
echo "→ Snapshot of prod → $REMOTE_DIR.bak-$STAMP"
# The snapshot lands beside the web root, not inside it, so it is never served.
"${SSH[@]}" "$REMOTE" "cp -a '$REMOTE_DIR' '$REMOTE_DIR.bak-$STAMP'"

echo "→ Uploading ${INCLUDE[*]}"
cd "$HERE"
if command -v rsync >/dev/null 2>&1; then
  rsync -avz -e "ssh -i $SSH_KEY" "${INCLUDE[@]}" "$REMOTE:$REMOTE_DIR/"
else
  # NOT `scp -r css …`: when the remote css/ already exists scp copies INTO it,
  # producing css/css/styles.css and leaving the real stylesheet stale. tar over
  # ssh preserves the tree exactly and needs nothing installed on either end.
  tar czf - "${INCLUDE[@]}" | "${SSH[@]}" "$REMOTE" "tar xzf - -C '$REMOTE_DIR'"
fi

# Everything else in the web root is www-data:www-data; match it so nginx can
# read the new files regardless of the umask tar restored them with.
echo "→ Fixing ownership"
"${SSH[@]}" "$REMOTE" "chown -R www-data:www-data '$REMOTE_DIR' && chmod -R u=rwX,go=rX '$REMOTE_DIR'"

echo "→ Verify"
fail=0
for p in "" search.html bot.html css/styles.css css/inspire-rail.css js/app.js js/inspire-rail.js images/personas/jubilee.png; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL/$p")
  echo "   $SITE_URL/$p -> $code"
  [ "$code" = "200" ] || fail=1
done

# Two clean URLs still need an nginx rewrite. Reported, not treated as a deploy
# failure, because the site works without them:
#
#   location = /search { try_files /search.html =404; }
#   location = /bot    { try_files /bot.html =404; }
#
# /bot is the one that matters. The crawler's user agent is fixed by the
# specification as JubileeSearchBot/1.0 (+https://jubileesearch.com/bot), so a
# webmaster who follows that link has to reach the bot page. Do not run any
# external crawl until it returns 200.
for p in "search?q=test" "bot"; do
  sc=$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL/$p")
  echo "   $SITE_URL/$p -> $sc  (404 = the rewrite is still missing)"
done

[ "$fail" = "0" ] && echo "Done." || { echo "Done, WITH FAILURES above."; exit 1; }
echo "Cloudflare may cache css/js for a while — purge the zone if the old look persists."
echo "Rollback: ssh $REMOTE \"rm -rf '$REMOTE_DIR' && mv '$REMOTE_DIR.bak-$STAMP' '$REMOTE_DIR'\""

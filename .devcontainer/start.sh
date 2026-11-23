#!/usr/bin/env bash
# Starts Scheduler in a dev container. In a Codespace, APP_URL is set to the forwarded port's public
# address so sign-in cookies and links work. Data lives in ./data (embedded PostgreSQL).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  if [ -n "${CODESPACE_NAME:-}" ]; then
    url="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  else
    url="http://localhost:3000"
  fi
  key="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
  printf 'APP_URL=%s\nENCRYPTION_KEY=%s\n' "$url" "$key" > .env
  echo "Created .env with APP_URL=$url"
fi

echo "Starting Scheduler on port 3000. Open the forwarded port, then create the owner account."
exec npm start

#!/bin/sh
# git-credential-vers — Git credential helper that mints GitHub tokens via Vers.
#
# Installed at /usr/local/bin/git-credential-vers by vers-fleets build scripts.
# Reads VERS_API_KEY from env, calls vers-landing to get an installation token.
# Only used for clone/create operations — agents use reef_github_token for
# scoped in-repo work.
#
# Usage: git config --global credential.https://github.com.helper /usr/local/bin/git-credential-vers

set -e

# Only respond to "get" requests
case "$1" in
  get) ;;
  *) exit 0 ;;
esac

# Read the request — we only care about github.com
host=""
while IFS='=' read -r key value; do
  case "$key" in
    host) host="$value" ;;
    "") break ;;
  esac
done

case "$host" in
  github.com) ;;
  *) exit 0 ;;
esac

# Resolve API key
if [ -z "$VERS_API_KEY" ]; then
  exit 1
fi

# Resolve base URL (default to vers.sh)
BASE_URL="${VERS_BASE_URL:-https://vers.sh}"

# Mint a full-org installation token
RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/github/installation-token" \
  -H "Authorization: Bearer ${VERS_API_KEY}" \
  -H "Content-Type: application/json" 2>/dev/null) || exit 1

TOKEN=$(printf '%s' "$RESPONSE" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  exit 1
fi

printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=%s\n' "$TOKEN"

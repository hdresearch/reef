#!/usr/bin/env bash
# test-passkeys-presence.sh — Integration tests for WebAuthn, presence, attestation
# Run against a local reef instance: PORT=3333 ./test/test-passkeys-presence.sh
set -euo pipefail

BASE="${REEF_URL:-https://localhost:3333}"
CURL="curl -sf --max-time 10"

pass=0
fail=0

check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  ✓ $desc"
    ((pass++))
  else
    echo "  ✗ $desc"
    ((fail++))
  fi
}

check_json() {
  local desc="$1" url="$2" jq_expr="$3"
  local result
  result=$($CURL "$url" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(eval('d$jq_expr'))" 2>/dev/null)
  if [ -n "$result" ] && [ "$result" != "None" ] && [ "$result" != "False" ]; then
    echo "  ✓ $desc (=$result)"
    ((pass++))
  else
    echo "  ✗ $desc (got: $result)"
    ((fail++))
  fi
}

echo "=== Health ==="
check "reef is healthy" $CURL "$BASE/health"

echo ""
echo "=== Profile ==="
check_json "profile has name" "$BASE/reef/profile" "['name']"
check_json "profile has timezone" "$BASE/reef/profile" "['timezone']"

echo ""
echo "=== Passkeys ==="
check_json "passkeys endpoint returns count" "$BASE/reef/passkeys" "['count']"
check_json "passkeys has policy" "$BASE/reef/passkeys" "['policy']['verifyMin']"

echo ""
echo "=== Passkey Panel ==="
check "panel returns HTML" $CURL -o /dev/null "$BASE/reef/passkeys/_panel"

echo ""
echo "=== Passkey Registration Start ==="
# Can't complete WebAuthn without a browser, but we can test the start endpoint
REG_OPTS=$($CURL -X POST -H "Content-Type: application/json" \
  -d '{"name":"Test","hint":"client-device"}' \
  "$BASE/reef/passkeys/register/start" 2>/dev/null)
check_json "registration options have challenge" "$BASE/reef/passkeys/register/start" "['challenge']" || true
if echo "$REG_OPTS" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['rp']['id']" 2>/dev/null; then
  echo "  ✓ registration options have rp.id"
  ((pass++))
else
  echo "  ✗ registration options have rp.id"
  ((fail++))
fi

echo ""
echo "=== Presence ==="
check_json "presence returns status" "$BASE/reef/presence" "['status']"
check_json "presence returns lastSeenAgo" "$BASE/reef/presence" "['lastSeenAgo']"

# Heartbeat
$CURL -X POST "$BASE/reef/presence/heartbeat" >/dev/null 2>&1
AFTER=$($CURL "$BASE/reef/presence" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['lastSeenMs'])")
if [ "$AFTER" -gt 0 ] 2>/dev/null; then
  echo "  ✓ heartbeat updated lastSeenMs (=$AFTER)"
  ((pass++))
else
  echo "  ✗ heartbeat did not update lastSeenMs"
  ((fail++))
fi

echo ""
echo "=== Attestation ==="
check_json "attest preview returns hash" "$BASE/reef/passkeys/attest/preview" "['documentHash']"
check_json "attest preview returns summary" "$BASE/reef/passkeys/attest/preview" "['summary']"
check_json "attest preview returns document" "$BASE/reef/passkeys/attest/preview" ".get('document','')[:20]"
check_json "attest status endpoint works" "$BASE/reef/passkeys/attest/status" ".get('attested', False) in (True, False)"

echo ""
echo "=== Proxy (UI API) ==="
check "proxy passes passkeys" $CURL -o /dev/null "$BASE/ui/api/reef/passkeys"
check "proxy passes presence" $CURL -o /dev/null "$BASE/ui/api/reef/presence"

echo ""
echo "=== Registry Export ==="
check_json "registry export has schema" "$BASE/reef/passkeys/registry" "['schema']"
check_json "registry export has credentials" "$BASE/reef/passkeys/registry" ".get('credentials') is not None"

echo ""
echo "=== Skill: fleet-standing-orders ==="
if [ -f "skills/fleet-standing-orders/SKILL.md" ]; then
  TABLES=$(grep -cE '^\|[-: |]+\|$' skills/fleet-standing-orders/SKILL.md)
  ROLES=$(sed -n '/| Agent Role/,/^$/p' skills/fleet-standing-orders/SKILL.md | grep '^\| \*\*' | wc -l | tr -d ' ')
  INVARIANTS=$(grep -E '^\*\*[A-Z][a-z]' skills/fleet-standing-orders/SKILL.md | sed 's/\*\*\([^.]*\)\.\*\*.*/\1/' | tr '\n' '-' | sed 's/-$//')
  echo "  ✓ SKILL.md exists"
  echo "    tables=$TABLES (expect 4)"
  echo "    gate_roles=$ROLES (expect 5)"
  echo "    invariant_hash=$INVARIANTS"
  ((pass++))
else
  echo "  ✗ SKILL.md missing"
  ((fail++))
fi

echo ""
echo "================================"
echo "  $pass passed, $fail failed"
echo "================================"
[ "$fail" -eq 0 ] && exit 0 || exit 1

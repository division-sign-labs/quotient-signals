#!/usr/bin/env bash
# notifications.sh — the cached read of GET /api/v2/pro/notifications (the member's alerts).
#
# The feed has no parameters, and a key has 50 calls a day across both feeds, so this script
# keeps each reply for 10 minutes and prints the quota that is left. Filter locally.
#
#   scripts/notifications.sh [--unread] [--kind KIND] [--fresh] [--json]
#
# Env: QUOTIENT_PRO_KEY (required), QUOTIENT_BASE_URL (default https://app.quotient.social),
#      QUOTIENT_NOTIFICATIONS_CACHE_SECONDS (default 600).
# Exit: 0 ok · 1 request failed · 2 usage · 3 quota exhausted (429) · 4 key rejected (401/403)
set -euo pipefail

BASE="${QUOTIENT_BASE_URL:-https://app.quotient.social}"
TTL="${QUOTIENT_NOTIFICATIONS_CACHE_SECONDS:-600}"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/quotient-signals"
UNREAD=0
KIND=""
FRESH=0
JSON=0

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --unread) UNREAD=1; shift ;;
    --kind) [ $# -ge 2 ] || usage; KIND="$2"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --json) JSON=1; shift ;;
    -h|--help) usage ;;
    *) echo "notifications.sh: unknown option $1" >&2; usage ;;
  esac
done

for tool in curl jq; do command -v "$tool" >/dev/null || { echo "notifications.sh: $tool is required" >&2; exit 2; }; done
[ -n "${QUOTIENT_PRO_KEY:-}" ] || { echo "notifications.sh: QUOTIENT_PRO_KEY is not set. Create a key at $BASE/agents." >&2; exit 2; }
case "$QUOTIENT_PRO_KEY" in qp_*) ;; *) echo "notifications.sh: QUOTIENT_PRO_KEY must start with qp_." >&2; exit 2 ;; esac

mkdir -p "$CACHE_DIR"
BODY="$CACHE_DIR/notifications.json"
HEAD="$CACHE_DIR/notifications.headers"

fresh_enough() {
  [ -s "$BODY" ] || return 1
  local age
  if stat -f %m "$BODY" >/dev/null 2>&1; then age=$(( $(date +%s) - $(stat -f %m "$BODY") )); else age=$(( $(date +%s) - $(stat -c %Y "$BODY") )); fi
  [ "$age" -lt "$TTL" ]
}

if [ "$FRESH" -eq 1 ] || ! fresh_enough; then
  TMP="$BODY.tmp"
  STATUS=$(curl -sS -o "$TMP" -D "$HEAD.tmp" -w '%{http_code}' -H "Authorization: Bearer $QUOTIENT_PRO_KEY" -H 'accept: application/json' "$BASE/api/v2/pro/notifications" || echo 000)
  case "$STATUS" in
    200) mv "$TMP" "$BODY"; mv "$HEAD.tmp" "$HEAD" ;;
    429) echo "notifications.sh: the key made 50 requests today. Resets at 00:00 UTC ($(grep -i '^retry-after' "$HEAD.tmp" | tr -d '\r' | awk '{print $2}') s)." >&2; rm -f "$TMP" "$HEAD.tmp"; exit 3 ;;
    401|403) echo "notifications.sh: the key was rejected ($STATUS): $(jq -r '.message // .error // empty' "$TMP" 2>/dev/null)" >&2; rm -f "$TMP" "$HEAD.tmp"; exit 4 ;;
    *) echo "notifications.sh: request failed ($STATUS): $(jq -r '.message // .error // empty' "$TMP" 2>/dev/null)" >&2; rm -f "$TMP" "$HEAD.tmp"; exit 1 ;;
  esac
  REMAINING=$(grep -i '^x-ratelimit-remaining' "$HEAD" | tr -d '\r' | awk '{print $2}')
  [ -n "$REMAINING" ] && echo "notifications.sh: $REMAINING of 50 requests left today" >&2
else
  echo "notifications.sh: cached reply ($BODY)" >&2
fi

FILTERED=$(jq --arg unread "$UNREAD" --arg kind "$KIND" '.items |= map(select(($unread != "1" or .unread == true) and ($kind == "" or .kind == $kind)))' "$BODY")

if [ "$JSON" -eq 1 ]; then
  printf '%s\n' "$FILTERED"
  exit 0
fi

# One line per alert: TIME KIND NEW TITLE · the numbers the kind carries.
printf '%s\n' "$FILTERED" | jq -r '
  def pad(n): tostring | . + " " * (n - length) | .[0:n];
  def detail:
    if .kind == "signal" then "\(.pick // "?") over \(.against // "?") · \(.marketCents // "?")¢ market, \(.qCents // "?")¢ Q"
    elif .kind == "position_move" then "\(.side // "?") \(.entryCents // "?")¢ → \(.nowCents // "?")¢ (\(if (.movePct // 0) > 0 then "+" else "" end)\(.movePct // 0)%) on \(.venue // "?")"
    elif .kind == "position_q_move" then "Q \(.previousPct // "?") → \(.currentPct // "?")\(if .flipped then ", flipped" else "" end)"
    elif .kind == "forecast_move" or .kind == "market_move" then "\(.previousPct // "?") → \(.currentPct // "?") (\(if (.deltaPp // 0) > 0 then "+" else "" end)\(.deltaPp // 0)pp)"
    elif .kind == "reforecast" then "\(.status)\(if .qPct != null then " · Q \(.qPct)%" else "" end)"
    elif .kind == "list_match" or .kind == "list_move" then "list \(.listName // "?")"
    elif .kind == "reply" or .kind == "trader_trade" then (.actor.name // "")
    else "" end;
  "\("TIME"|pad(6)) \("KIND"|pad(16)) \("NEW"|pad(3)) MARKET · DETAIL",
  (.items[] | "\(.at[11:16]) \(.kind|pad(16)) \(if .unread then "•" else " " end|pad(3)) \(.title) · \(detail)")'

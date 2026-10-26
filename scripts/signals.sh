#!/usr/bin/env bash
# signals.sh — the cached read of GET /api/v2/pro/signals.
#
# One call returns every matching signal, and a key has 50 calls a day, so this script keeps each
# reply for 30 minutes (per query) and prints the quota that is left. Filter the JSON with jq;
# never call once per signal.
#
#   scripts/signals.sh [--topic T] [--venue V] [--side YES|NO] [--status S] [--min-conviction N]
#                      [--min-edge PP] [--fresh] [--json]
#
# Env: QUOTIENT_PRO_KEY (required), QUOTIENT_BASE_URL (default https://app.quotient.social),
#      QUOTIENT_CACHE_SECONDS (default 1800).
# Exit: 0 ok · 1 request failed · 2 usage · 3 quota exhausted (429) · 4 key rejected (401/403)
set -euo pipefail

BASE="${QUOTIENT_BASE_URL:-https://app.quotient.social}"
TTL="${QUOTIENT_CACHE_SECONDS:-1800}"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/quotient-signals"
MIN_CONVICTION=0
MIN_EDGE=0
FRESH=0
JSON=0
declare -a QUERY=()

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --topic|--venue|--side|--status|--window|--market|--sort)
      [ $# -ge 2 ] || usage
      QUERY+=("${1#--}=$2"); shift 2 ;;
    --min-conviction) [ $# -ge 2 ] || usage; MIN_CONVICTION="$2"; QUERY+=("min_conviction=$2"); shift 2 ;;
    --min-edge) [ $# -ge 2 ] || usage; MIN_EDGE="$2"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --json) JSON=1; shift ;;
    -h|--help) usage ;;
    *) echo "signals.sh: unknown option $1" >&2; usage ;;
  esac
done

for tool in curl jq; do command -v "$tool" >/dev/null || { echo "signals.sh: $tool is required" >&2; exit 2; }; done
[ -n "${QUOTIENT_PRO_KEY:-}" ] || { echo "signals.sh: QUOTIENT_PRO_KEY is not set. Create a key at $BASE/agents." >&2; exit 2; }
case "$QUOTIENT_PRO_KEY" in qp_*) ;; *) echo "signals.sh: QUOTIENT_PRO_KEY must start with qp_." >&2; exit 2 ;; esac

# The cache key is the sorted query, so the same filters hit the same file.
QS=""
if [ ${#QUERY[@]} -gt 0 ]; then
  QS=$(printf '%s\n' "${QUERY[@]}" | sort | paste -sd '&' -)
fi
mkdir -p "$CACHE_DIR"
KEY=$(printf '%s' "$QS" | shasum -a 256 | cut -c1-16)
BODY="$CACHE_DIR/$KEY.json"
HEAD="$CACHE_DIR/$KEY.headers"

fresh_enough() {
  [ -s "$BODY" ] || return 1
  local age
  if stat -f %m "$BODY" >/dev/null 2>&1; then age=$(( $(date +%s) - $(stat -f %m "$BODY") )); else age=$(( $(date +%s) - $(stat -c %Y "$BODY") )); fi
  [ "$age" -lt "$TTL" ]
}

if [ "$FRESH" -eq 1 ] || ! fresh_enough; then
  URL="$BASE/api/v2/pro/signals"; [ -n "$QS" ] && URL="$URL?$QS"
  TMP="$BODY.tmp"
  STATUS=$(curl -sS -o "$TMP" -D "$HEAD.tmp" -w '%{http_code}' -H "Authorization: Bearer $QUOTIENT_PRO_KEY" -H 'accept: application/json' "$URL" || echo 000)
  case "$STATUS" in
    200) mv "$TMP" "$BODY"; mv "$HEAD.tmp" "$HEAD" ;;
    429) echo "signals.sh: the key made 50 requests today. Resets at 00:00 UTC ($(grep -i '^retry-after' "$HEAD.tmp" | tr -d '\r' | awk '{print $2}') s)." >&2; rm -f "$TMP" "$HEAD.tmp"; exit 3 ;;
    401|403) echo "signals.sh: the key was rejected ($STATUS): $(jq -r '.message // .error // empty' "$TMP" 2>/dev/null)" >&2; rm -f "$TMP" "$HEAD.tmp"; exit 4 ;;
    *) echo "signals.sh: request failed ($STATUS): $(jq -r '.message // .error // empty' "$TMP" 2>/dev/null)" >&2; rm -f "$TMP" "$HEAD.tmp"; exit 1 ;;
  esac
  REMAINING=$(grep -i '^x-ratelimit-remaining' "$HEAD" | tr -d '\r' | awk '{print $2}')
  [ -n "$REMAINING" ] && echo "signals.sh: $REMAINING of 50 requests left today" >&2
else
  echo "signals.sh: cached reply ($BODY)" >&2
fi

# Local filters run on the cached JSON. The edge of an event row is q_value_cents - current_cost_cents;
# a game listing carries edge_pp.
FILTER='
  def edge_of(s): if s.kind == "sports_game" then ([s.markets[]? | select(.entry_eligible == true) | .edge_pp] | max // 0)
                  else ((s.q_value_cents // 0) - (s.current_cost_cents // 0)) end;
  .signals |= map(select((.conviction_tier // 0) >= ($minConviction|tonumber) and edge_of(.) >= ($minEdge|tonumber)))'
FILTERED=$(jq --arg minConviction "$MIN_CONVICTION" --arg minEdge "$MIN_EDGE" "$FILTER" "$BODY")

if [ "$JSON" -eq 1 ]; then
  printf '%s\n' "$FILTERED"
  exit 0
fi

# One line per signal: SIDE COST Q EDGE TIER VENUE MARKET.
printf '%s\n' "$FILTERED" | jq -r '
  def pad(n): tostring | . + " " * (n - length) | .[0:n];
  def line(side; cost; q; edge; tier; venue; title):
    "\(side|pad(4)) \((cost|tostring) + "¢"|pad(5)) \((q|tostring) + "¢"|pad(5)) \(("+" + (edge|tostring) + "pp")|pad(7)) \("t" + (tier|tostring)|pad(3)) \(venue|pad(12)) \(title)";
  (["SIDE","COST","Q","EDGE","TIER","VENUE","MARKET"] | "\(.[0]|pad(4)) \(.[1]|pad(5)) \(.[2]|pad(5)) \(.[3]|pad(7)) \(.[4]|pad(3)) \(.[5]|pad(12)) \(.[6])"),
  (.signals[] |
    if .kind == "sports_game" then
      (.markets[] | select(.entry_eligible == true)) as $m |
      line($m.signal_side // "?"; $m.current_cost_cents // 0; ((.pick.probability // 0) * 100 | round); $m.edge_pp // 0; .conviction_tier // "-"; $m.venue; "\(.pick.label) · \(.sports.game_title) · \($m.nativeMarketId // $m.slug)")
    else
      line(.side; .current_cost_cents // 0; .q_value_cents // 0; ((.q_value_cents // 0) - (.current_cost_cents // 0)); .conviction_tier // "-"; .market.venue; "\(.market.question) · \(.market.nativeMarketId // .market.slug)")
    end)'

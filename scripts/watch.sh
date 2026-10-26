#!/usr/bin/env bash
# watch.sh — the signals read on a timer, with a hook when something changed.
#
#   scripts/watch.sh [--every MINUTES] [--topic T] [--venue V] [--side S] [--status S] [-- <command> [args]]
#
# Every N minutes (default 30, which is 48 of the 50 daily calls) the script fetches a fresh reply
# through signals.sh, compares the signal ids and forecast_updated_at values with the last reply,
# prints what is new, reforecast or gone, and pipes the fresh JSON to <command> on stdin when
# anything changed. It stops when fewer than 2 requests are left for the day, or on a rejected key.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EVERY=30
declare -a PASS=()
declare -a HOOK=()
while [ $# -gt 0 ]; do
  case "$1" in
    --every) EVERY="$2"; shift 2 ;;
    --) shift; HOOK=("$@"); break ;;
    *) PASS+=("$1"); shift ;;
  esac
done
[ "$EVERY" -ge 15 ] || { echo "watch.sh: --every must be 15 minutes or more (50 calls a day)" >&2; exit 2; }

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/quotient-signals"
mkdir -p "$STATE_DIR"
LAST="$STATE_DIR/watch-last.json"

while :; do
  set +e
  FRESH=$("$HERE/signals.sh" --fresh --json "${PASS[@]}" 2> "$STATE_DIR/watch-stderr.txt")
  CODE=$?
  set -e
  cat "$STATE_DIR/watch-stderr.txt" >&2
  case "$CODE" in
    0) ;;
    3) echo "watch.sh: quota exhausted, stopping until tomorrow" >&2; exit 3 ;;
    4) echo "watch.sh: key rejected, stopping" >&2; exit 4 ;;
    *) echo "watch.sh: read failed, trying again in $EVERY min" >&2; sleep $(( EVERY * 60 )); continue ;;
  esac
  REMAINING=$(sed -n 's/^signals.sh: \([0-9]*\) of 50 requests left today$/\1/p' "$STATE_DIR/watch-stderr.txt")

  if [ -s "$LAST" ]; then
    CHANGES=$(jq -n --argjson a "$(cat "$LAST")" --argjson b "$FRESH" '
      def idx(x): x.signals | map({key: .id, value: (.forecast_updated_at // "")}) | from_entries;
      (idx($a)) as $old | (idx($b)) as $new |
      { new: [$new | keys[] | select($old[.] == null)],
        reforecast: [$new | keys[] | select($old[.] != null and $old[.] != $new[.])],
        gone: [$old | keys[] | select($new[.] == null)] }')
    COUNT=$(printf '%s' "$CHANGES" | jq '(.new|length) + (.reforecast|length) + (.gone|length)')
    echo "watch.sh: $(date -u +%H:%MZ) $(printf '%s' "$CHANGES" | jq -r '"\(.new|length) new · \(.reforecast|length) reforecast · \(.gone|length) gone"')" >&2
    if [ "$COUNT" -gt 0 ] && [ ${#HOOK[@]} -gt 0 ]; then
      printf '%s' "$FRESH" | "${HOOK[@]}" || echo "watch.sh: hook exited $?" >&2
    fi
  else
    echo "watch.sh: $(date -u +%H:%MZ) first read, $(printf '%s' "$FRESH" | jq '.signals|length') signals" >&2
  fi
  printf '%s' "$FRESH" > "$LAST"

  if [ -n "$REMAINING" ] && [ "$REMAINING" -lt 2 ]; then
    echo "watch.sh: $REMAINING requests left, stopping until 00:00 UTC" >&2
    exit 0
  fi
  sleep $(( EVERY * 60 ))
done

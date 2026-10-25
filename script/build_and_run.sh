#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-run}"
case "$MODE" in
  run|--verify|--debug|--logs) ;;
  *) echo "Usage: $0 [run|--verify|--debug|--logs]" >&2; exit 2 ;;
esac
# Quit the previous local build before replacing its files.
if pgrep -x StykAnimate >/dev/null; then
  osascript -e 'tell application "StykAnimate" to quit'
  if pgrep -x StykAnimate >/dev/null; then
    echo "Close StykAnimate after saving your work, then run this command again." >&2
    exit 1
  fi
fi
bash scripts/build-macos.sh --dir
APP="$PWD/release/mac-arm64/StykAnimate.app"
case "$MODE" in
  --verify) npm run test:boot:packaged ;;
  --debug) exec lldb -- "$APP/Contents/MacOS/StykAnimate" ;;
  --logs)
    open -n "$APP"
    exec /usr/bin/log stream --info --style compact --predicate 'process == "StykAnimate"'
    ;;
  run) open -n "$APP" ;;
esac

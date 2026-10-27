#!/usr/bin/env bash
# Records what the Python codec answers and replays it against styk-piv.
#
#   engine/tools/piv/parity.sh                 # every suite (the corpus ones need ~/Downloads)
#   engine/tools/piv/parity.sh --quick         # leave out the large ~/Downloads/pivs files
#   engine/tools/piv/parity.sh --suite fixtures --suite service
#
# Arguments go to oracle.py. Suites that need the private corpus print a
# "skipped" line when it is absent; the fixture, service, native and document
# suites always run. Exits non-zero when any answer differs.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
out="${STYK_PIV_PARITY:-$repo/engine/target/piv-parity}"
python="${PYTHON:-$repo/.venv/bin/python}"
if [ ! -x "$python" ]; then
  echo "skipped: no Python at $python (create .venv as README.md describes, or set PYTHON)" >&2
  exit 0
fi
rm -rf "$out"
"$python" "$repo/engine/tools/piv/oracle.py" --out "$out" "$@"
cd "$repo/engine"
cargo build --release -p styk-piv
"${CARGO_TARGET_DIR:-$repo/engine/target}/release/styk-piv" replay "$out"

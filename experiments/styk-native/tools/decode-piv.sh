#!/usr/bin/env bash
# Decode a Pivot .piv with the repository's Python codec (the desktop import
# path) into a JSON document for tools/reference.mjs and the decoder parity test.
#   tools/decode-piv.sh <file.piv> <out.json>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
python="${STYK_PYTHON:-$repo/.venv/bin/python}"
[ -x "$python" ] || python=python3
exec "$python" "$repo/codecs/piv_codec.py" "$1" --out "$2"

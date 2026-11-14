#!/bin/sh
# Builds and runs the host-side tests of the C++ core. Needs g++, zlib and
# python3 (python generates the container fixtures with the project's own
# encoder logic). Exits 0 with a SKIPPED note when a tool is missing, so builds
# on machines without a host toolchain are not blocked.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
core="$here/../app/src/main/cpp/core"
out="${TMPDIR:-/tmp}/styk-core-tests"

if ! command -v g++ >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1 ||
   ! printf '#include <zlib.h>\nint main(){return 0;}\n' | g++ -x c++ -fsyntax-only - 2>/dev/null; then
  echo "core tests SKIPPED: g++, zlib headers or python3 not available"
  exit 0
fi

mkdir -p "$out"
python3 "$here/tools/gen_fixtures.py" "$out/native_fixtures.h"
g++ -std=c++17 -Wall -Wextra -O1 -g -fsanitize=address,undefined \
  -I"$core" -I"$out" "$here/native_test.cpp" \
  "$core/sha256.cpp" "$core/base64.cpp" "$core/json.cpp" "$core/native_container.cpp" "$core/styk_core.cpp" \
  -lz -o "$out/native_test"
"$out/native_test"

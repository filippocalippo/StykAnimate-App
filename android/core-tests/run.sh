#!/bin/sh
# Builds and runs the host-side tests of the C++ core. Needs g++ and zlib.
# Exits 0 with a SKIPPED note when the toolchain is missing, so builds on
# machines without a host compiler are not blocked.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
core="$here/../app/src/main/cpp/core"
out="${TMPDIR:-/tmp}/styk-core-tests"

if ! command -v g++ >/dev/null 2>&1 ||
   ! printf '#include <zlib.h>\nint main(){return 0;}\n' | g++ -x c++ -fsyntax-only - 2>/dev/null; then
  echo "core tests SKIPPED: g++ or zlib headers not available"
  exit 0
fi

mkdir -p "$out"
g++ -std=c++17 -Wall -Wextra -O1 -g -fsanitize=address,undefined \
  -I"$core" "$here/piv_test.cpp" "$core/piv.cpp" "$core/styk_core.cpp" \
  -lz -o "$out/piv_test"
"$out/piv_test"

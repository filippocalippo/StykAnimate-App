#!/usr/bin/env bash
# Runs the engine benchmark matrix (docs/RUST-ENGINE-PORT.md section 5) in rounds:
# every configuration of every file once per round, so slow changes in machine load
# spread over all of them instead of landing on one. Results accumulate under
# artifacts/engine-rust/bench/<label>/ (run numbers continue after existing ones).
#
#   scripts/engine-bench-matrix.sh <label> <checkout> <first round> <last round> [config…]
#
# <checkout> is the tree whose app is measured (a worktree for a baseline).
# Configurations: gpu web gpu4 touch webkit (all by default).
# Each run waits until the 1-minute load is below 3 (12 threads here) and records it.
set -u
label=$1 root=$2 first=$3 last=$4; shift 4
configs=("$@"); [ ${#configs[@]} -eq 0 ] && configs=(gpu web gpu4 touch webkit)
cd "$(dirname "$0")/.."
unset ELECTRON_RUN_AS_NODE
files=("$HOME/Downloads/TDD2 URIEL NEMESIS 3.styk" "$HOME/Downloads/Jay on a new app (repaired).styk"
  "$HOME/Downloads/pivs/svr_uriel.piv" "$HOME/Downloads/pivs/tdd2 uriel nemesis.piv")
flags() {
  case $1 in
    gpu) ;; web) echo --target web-chromium ;; gpu4) echo --throttle 4 ;;
    touch) echo --target web-chromium --touch ;; webkit) echo --target web-webkit ;;
    *) echo "unknown configuration $1" >&2; exit 2 ;;
  esac
}
for ((round = first; round <= last; round++)); do
  # Alternate the file order between rounds as well.
  order=("${files[@]}"); ((round % 2 == 0)) && order=("${files[3]}" "${files[2]}" "${files[1]}" "${files[0]}")
  for config in "${configs[@]}"; do
    for file in "${order[@]}"; do
      echo "=== round $round $(date +%T) $config $(basename "$file") load $(cut -d' ' -f1-3 /proc/loadavg)"
      # shellcheck disable=SC2046
      timeout 3600 node scripts/engine-benchmark.mjs --label "$label" --root "$root" --wait-idle 3 --file "$file" $(flags "$config") 2>&1 |
        grep -E "^RESULT|Error|error" | cut -c1-600
    done
  done
done
echo "=== done $(date +%T)"

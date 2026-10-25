#!/usr/bin/env bash
# Build a self-contained Apple Silicon app. Nothing is uploaded or published.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 || "$(node -p process.arch)" != arm64 ]]; then
  echo "Build on Apple Silicon with native arm64 Node.js (without Rosetta)." >&2
  exit 1
fi
command -v uv >/dev/null || { echo "Install uv before building the bundled Python tools." >&2; exit 1; }
# Select the SDK that belongs to the active Xcode toolchain.
export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
export MACOSX_DEPLOYMENT_TARGET=12.0
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm ci --no-audit --no-fund
uv venv --python 3.12.9 --allow-existing .venv
uv pip install --python .venv/bin/python -r scripts/requirements-build.txt -r backend/requirements-fast.txt
uv run --python .venv/bin/python scripts/build-frame-scan.py
uv run --python .venv/bin/python scripts/build-sidecar.py
npm run verify:sidecar
uv run --python .venv/bin/python scripts/stage-video-encoder.py
npm run dist:mac -- --arm64 --publish never --config.mac.identity=- "$@"
npm run verify:package

#!/usr/bin/env bash
# FrameLab replay: a fresh run of the frozen scenario on a clean local stack.
# It is a new execution, not playback of the saved events.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${FRAMELAB:?set FRAMELAB to a FrameLab checkout (bundle was made at d2d3beca038e6136976546e69d5d9bfb98e655a8)}"

cd "$HERE"
shasum -a 256 -c SHA256SUMS --quiet || { echo "replay: bundle files do not match SHA256SUMS; refusing to run" >&2; exit 2; }
bun "$FRAMELAB/src/cli.ts" check-pins "$HERE"

# Replay output holds runtime files (engine JWT, logs); keep it out of the bundle so the bundle stays shareable.
OUT="${FRAMELAB_REPLAY_OUT:-$FRAMELAB/.runs/replay-$(basename "$HERE")-$(date +%Y%m%d-%H%M%S)}"
set +e
bun "$FRAMELAB/src/cli.ts" run "$HERE/scenario.original.yaml" --label "observe"  --out "$OUT"
code=$?
set -e
bun "$FRAMELAB/src/cli.ts" compare "$HERE" "$OUT" || true
echo "replay exit $code (bundle recorded 0)"
exit $code

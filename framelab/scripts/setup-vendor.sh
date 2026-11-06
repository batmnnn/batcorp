#!/usr/bin/env bash
# Clones the two pinned upstreams FrameLab runs against into vendor/, next to framelab/. They are
# read-only inputs and are never committed. Re-running only checks out the pinned commits again.
#
#   scripts/setup-vendor.sh                 sidecar, plus the ethrex genesis fixture only
#   FULL_ETHREX=1 scripts/setup-vendor.sh   full ethrex source, needed to build the arm64 image
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
read -r SIDECAR_REPO SIDECAR_COMMIT ETHREX_REPO ETHREX_COMMIT VENDOR < <(bun -e '
  const { SIDECAR_PIN, ETHREX_PIN, VENDOR_DIR } = await import("./src/env/pins.ts");
  console.log(SIDECAR_PIN.repo, SIDECAR_PIN.commit, ETHREX_PIN.repo, ETHREX_PIN.commit, VENDOR_DIR);
')
mkdir -p "$VENDOR"

# fetch_pinned <dir> <repo> <commit> [sparse path]: only the pinned commit, without history.
fetch_pinned() {
  local dir="$1" repo="$2" commit="$3" sparse="${4:-}"
  if [ ! -d "$dir/.git" ]; then
    git init --quiet "$dir"
    git -C "$dir" remote add origin "$repo"
    if [ -n "$sparse" ]; then
      git -C "$dir" sparse-checkout set --no-cone "$sparse"
      git -C "$dir" fetch --quiet --depth 1 --filter=blob:none origin "$commit"
    else
      git -C "$dir" fetch --quiet --depth 1 origin "$commit"
    fi
  fi
  git -C "$dir" checkout --quiet --detach "$commit"
}

fetch_pinned "$VENDOR/sidecar" "$SIDECAR_REPO" "$SIDECAR_COMMIT"
if [ "${FULL_ETHREX:-0}" = 1 ]; then
  fetch_pinned "$VENDOR/ethrex" "$ETHREX_REPO" "$ETHREX_COMMIT"
else
  fetch_pinned "$VENDOR/ethrex" "$ETHREX_REPO" "$ETHREX_COMMIT" /fixtures/genesis/
fi

echo "vendor/sidecar at $(git -C "$VENDOR/sidecar" rev-parse --short HEAD), vendor/ethrex at $(git -C "$VENDOR/ethrex" rev-parse --short HEAD) -> $VENDOR"

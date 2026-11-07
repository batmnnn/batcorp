#!/usr/bin/env bash
# FrameLab in a GitHub Codespace, run from .devcontainer/devcontainer.json. Same steps as CI.
#
#   codespace.sh setup   Bun, dependencies, the pinned sources and ethrex image, then a warm-up replay
#   codespace.sh serve   starts the UI on port 4173 unless it is already up
set -euo pipefail
cd "$(dirname "$0")/.."
BUN_VERSION=1.3.14
export PATH="$HOME/.bun/bin:$PATH"

case "${1:-}" in
  setup)
    if [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
      [ -x /usr/bin/unzip ] || { sudo apt-get update -qq && sudo apt-get install -y -qq unzip; }
      curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
    fi
    bun install --frozen-lockfile
    scripts/setup-vendor.sh
    # The Docker daemon starts with the container and may still be coming up.
    for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
    docker image inspect "$FRAMELAB_ETHREX_IMAGE" >/dev/null 2>&1 || docker pull "$FRAMELAB_ETHREX_IMAGE"
    echo "warm-up: replaying evidence/v0.1-rc/s1-pass (builds the sidecar; must exit 0)"
    # A failed warm-up must not fail the codespace: it would open in a recovery container instead.
    if FRAMELAB="$PWD" evidence/v0.1-rc/s1-pass/replay.sh; then
      echo "FrameLab is set up. The UI opens on port 4173."
    else
      echo "codespace: the warm-up replay did not pass; FrameLab is installed, see the output above" >&2
    fi
    ;;
  serve)
    if curl -fsS -o /dev/null "http://127.0.0.1:4173/"; then
      echo "FrameLab UI is already running on port 4173"
      exit 0
    fi
    setsid nohup bun src/cli.ts serve --port 4173 >/tmp/framelab-ui.log 2>&1 </dev/null &
    echo "FrameLab UI starting on port 4173 (log: /tmp/framelab-ui.log)"
    ;;
  *)
    echo "usage: codespace.sh setup|serve" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
# The §11 acceptance suite on the pinned local stack. Every step's output and exit code is kept
# under the result folder, and summary.tsv is written by this script as the steps finish.
# Acceptance 8 checks only the server guards here; the UI states need a person at the browser.
#
#   scripts/acceptance.sh [result-dir]       exit 0 only if every step met its expectation
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="${1:-$ROOT/.runs/freeze-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)"
R="$OUT/runs"
LOGS="$OUT/logs"
SUMMARY="$OUT/summary.tsv"
mkdir -p "$R" "$LOGS"
: >"$SUMMARY"
MET=0
UNMET=0

fl() { bun "$ROOT/src/cli.ts" "$@"; }

record() { # record <id> <ok|UNMET> <seen> <seconds> <what>
  printf '%s\t%s\t%s\t%ss\t%s\n' "$1" "$2" "$3" "$4" "$5" | tee -a "$SUMMARY"
  if [ "$2" = ok ]; then MET=$((MET + 1)); else UNMET=$((UNMET + 1)); fi
}

step() { # step <id> <expected exit> <what> <command...>
  local id="$1" want="$2" what="$3" t0=$SECONDS got
  shift 3
  "$@" >"$LOGS/$id.log" 2>&1
  got=$?
  record "$id" "$([ "$got" = "$want" ] && echo ok || echo UNMET)" "exit $got (expected $want)" $((SECONDS - t0)) "$what"
}

fact() { # fact <id> <what> <check> <args...>
  local id="$1" what="$2" seen got
  shift 2
  seen="$(bun "$ROOT/scripts/acceptance-facts.ts" "$@" 2>&1)"
  got=$?
  printf '%s\n' "$seen" >"$LOGS/$id.log"
  record "$id" "$([ "$got" = 0 ] && echo ok || echo UNMET)" "$(printf '%s' "$seen" | tail -n 1)" 0 "$what"
}

absent() { # absent <id> <what> <path>
  if [ -e "$3" ]; then record "$1" UNMET "$3 exists" 0 "$2"; else record "$1" ok "not created" 0 "$2"; fi
}

{
  echo "framelab $(git rev-parse HEAD)"
  echo "uncommitted files: $(git status --porcelain | wc -l | tr -d ' ')"
  echo "started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "bun $(bun --version), docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unavailable)"
} >"$OUT/header.txt"
cat "$OUT/header.txt"

INJECT=(--patch patches/inject-s1-oldest-first.patch --label inject-s1)

# 0. Offline checks.
step a0-test 0 "unit tests (oracle, reducer, projection, compatibility, bundle)" bun test
step a0-typecheck 0 "typecheck" bun run typecheck

# 1. Fresh S1 (and S2) pass.
step a1-s1 0 "fresh S1 run" fl run scenarios/s1-payer-drop.yaml --out "$R/a1-s1"
fact a1-s1-facts "S1: reached assertions, agreeing projections, expected invalidation is green" fresh-pass "$R/a1-s1"
step a1-s2 0 "fresh S2 run" fl run scenarios/s2-storage-dep.yaml --out "$R/a1-s2"
fact a1-s2-facts "S2: reached assertions, agreeing projections" fresh-pass "$R/a1-s2"

# 2. One flipped expectation.
step a2 1 "flipped S1-A2 expectation fails" fl run scenarios/negative/s1-wrong-expectation.yaml --out "$R/a2"
fact a2-facts "fails at S1-A2 only, labelled a wrong test expectation" wrong-expectation "$R/a2" S1-A2

# 3. Each cause of doubt on its own gives INCONCLUSIVE.
step a3-zero 2 "zero reached assertions" fl run scenarios/negative/s1-zero-assertions.yaml --out "$R/a3-zero"
fact a3-zero-facts "zero assertions is INCONCLUSIVE" inconclusive "$R/a3-zero"
step a3-skip 2 "skipped required checkpoint" fl run scenarios/s1-payer-drop.yaml --fault skip-checkpoint@cp-trigger --out "$R/a3-skip"
fact a3-skip-facts "skipped checkpoint is INCONCLUSIVE" inconclusive "$R/a3-skip"
step a3-transport 2 "transport failure (sidecar killed)" fl run scenarios/s1-payer-drop.yaml --fault sidecar-down@cp-trigger --out "$R/a3-transport"
fact a3-transport-facts "transport failure is INCONCLUSIVE" inconclusive "$R/a3-transport"
step a3-timeout 2 "pass timeout" fl run scenarios/negative/s1-pass-timeout.yaml --out "$R/a3-timeout"
fact a3-timeout-facts "pass timeout is INCONCLUSIVE" inconclusive "$R/a3-timeout"
step a3-restart 2 "sidecar restart (history gap)" fl run scenarios/s1-payer-drop.yaml --fault sidecar-restart@cp-trigger --out "$R/a3-restart"
fact a3-restart-facts "restart is INCONCLUSIVE" inconclusive "$R/a3-restart"
step a3-inconsistent 2 "inconsistent double run (run 2 on the injected build)" fl run scenarios/s1-payer-drop.yaml --run2-patch patches/inject-s1-oldest-first.patch --run2-label inject-s1 --out "$R/a3-inconsistent"
fact a3-inconsistent-facts "inconsistent runs are INCONCLUSIVE" inconclusive "$R/a3-inconsistent"

# 4. Labelled injected regression, then shrink.
step a4 1 "s1-noisy on the LOCAL INJECTED build, then shrink" fl shrink scenarios/s1-noisy.yaml "${INJECT[@]}" --out "$R/a4"
fact a4-facts "same failure on both runs; smaller case reproduces on two fresh runs" shrunk "$R/a4"

# 5. Bundle and replay without the UI; tampering stops replay.
B="$OUT/bundle-a4"
step a5-export 0 "export the shrink result" fl export "$R/a4" --out "$B"
fact a5-clean "bundle holds only checksummed files and no engine JWT" bundle-clean "$B" "$R/a4"
step a5-pins 0 "check-pins on the bundle" fl check-pins "$B"
step a5-replay 1 "replay.sh reproduces the recorded FAIL" env FRAMELAB="$ROOT" FRAMELAB_REPLAY_OUT="$R/a5-replay" bash "$B/replay.sh"
fact a5-untouched "replay left the bundle folder unchanged" bundle-clean "$B" "$R/a4" "$R/a5-replay"

resum() { (cd "$1" && sed -E 's/^[0-9a-f]{64} [ *]//' SHA256SUMS | xargs shasum -a 256 >SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS); }
for kind in scenario missing-pin manifest sidecar-pin patch; do
  T="$OUT/tamper/$kind"
  mkdir -p "$OUT/tamper"
  cp -R "$B" "$T"
  case "$kind" in
    scenario) echo "# edited" >>"$T/scenario.min.yaml" ;;
    missing-pin) rm "$T/node_pin.json" ;;
    manifest) echo " " >>"$T/manifest.json" ;;
    sidecar-pin)
      bun -e "const f='$T/node_pin.json'; const p=JSON.parse(await Bun.file(f).text()); p.sidecar.commit='0'.repeat(40); await Bun.write(f, JSON.stringify(p, null, 2));"
      resum "$T" ;;
    patch)
      echo "+// edited" >>"$T/patches/inject-s1-oldest-first.patch"
      resum "$T" ;;
  esac
  step "a5-tamper-$kind" 2 "replay refuses a bundle with a tampered $kind" env FRAMELAB="$ROOT" FRAMELAB_REPLAY_OUT="$R/a5-tamper-$kind" bash "$T/replay.sh"
  absent "a5-tamper-$kind-no-node" "no node run for the tampered $kind" "$R/a5-tamper-$kind"
done

# 6. Secret scan: planted secrets stop export; real bundles carry no engine JWT.
P="$R/a6-plant"
cp -R "$R/a1-s1" "$P"
PLANTED_TOKEN="gh""p_$(printf 'F%.0s' $(seq 1 36))"
PLANTED_VALUE="$(openssl rand -hex 16)"
echo "{\"planted\":\"$PLANTED_TOKEN\"}" >>"$P/run1/rpc.jsonl"
echo "{\"planted\":\"$PLANTED_VALUE\"}" >>"$P/run2/rpc.jsonl"
step a6-plant 2 "export of a run with planted secrets is refused" env FRAMELAB_PLANTED_API_KEY="$PLANTED_VALUE" bun "$ROOT/src/cli.ts" export "$P" --out "$OUT/bundle-a6-plant"
fact a6-refused "both planted secrets found; no bundle left" refused "$OUT/bundle-a6-plant" "$LOGS/a6-plant.log"
step a6-s1-export 0 "export the fresh S1 run" fl export "$R/a1-s1" --out "$OUT/bundle-a1-s1"
fact a6-s1-clean "S1 bundle holds no engine JWT" bundle-clean "$OUT/bundle-a1-s1" "$R/a1-s1"

# 7. Fix comparison: same reduced scenario and rule pack on the unpatched build.
step a7-fixed 0 "reduced case on the unpatched build" fl run "$B/scenario.min.yaml" --out "$R/a7-fixed"
step a7-compare 0 "compare bundle vs fixed run" fl compare "$B" "$R/a7-fixed"
fact a7-facts "target now passes on a different build; expectations unchanged" compare-fixed "$R/a7-fixed"
step a7-mismatch 2 "compare refuses an unrelated pair" fl compare "$R/a1-s1" "$R/a1-s2"

# 8. Server guards (the UI states were exercised by hand; see §18.5).
PORT=4199
fl serve --port "$PORT" >"$LOGS/a8-serve.log" 2>&1 &
SERVE_PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.2; done
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect_status() { # expect_status <id> <code> <what> <curl args...>
  local id="$1" want="$2" what="$3" got
  shift 3
  got="$(status "$@")"
  record "$id" "$([ "$got" = "$want" ] && echo ok || echo UNMET)" "HTTP $got (expected $want)" 0 "$what"
}
expect_status a8-page 200 "viewer page on the local origin" "http://127.0.0.1:$PORT/"
expect_status a8-host 403 "foreign Host header refused" -H "Host: attacker.example" "http://127.0.0.1:$PORT/api/state"
expect_status a8-post 403 "POST without the FrameLab header refused" -X POST "http://127.0.0.1:$PORT/api/cancel"
expect_status a8-path 403 "path outside bundles/ and .runs/ refused" "http://127.0.0.1:$PORT/api/view?dir=/etc"
expect_status a8-dotdot 403 "relative escape refused" "http://127.0.0.1:$PORT/api/view?dir=bundles/../../.."
kill -INT "$SERVE_PID" 2>/dev/null
wait "$SERVE_PID" 2>/dev/null

# 9. A scenario for another codec is not applicable, and is not a failure.
step a9 2 "current-codec scenario is INCONCLUSIVE before any node starts" fl run scenarios/negative/s1-current-codec.yaml --out "$R/a9"
fact a9-facts "not applicable, no run started" not-applicable "$R/a9"
step a9-export 2 "export refuses a not-applicable result" fl export "$R/a9" --out "$OUT/bundle-a9"

echo "finished $(date -u +%Y-%m-%dT%H:%M:%SZ): $MET met, $UNMET not met" | tee -a "$OUT/header.txt"
[ "$UNMET" = 0 ]

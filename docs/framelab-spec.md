# FrameLab: product spec (FINAL, Classic track)

Decision: Shubham finalized FrameLab on 2026-11-06 07:56 IST and locked the Classic track at 08:00 IST. (History: from 07:56 to 08:00 IST the track was pending.) Classic rules apply: all project code is written from scratch during the hack. Use credited, licensed dependencies; do not pass upstream code off as new work.

Reference audit: 2026-11-06, IST. Classic and the product remain locked. This is a design audit, not proof that the runner works. No project code or node run was made for this audit.

Prize context [R1]: EF “Best use of the Frame Transaction Alternative Mempool”: $5,000 pool; $2,500 / $1,500 / $1,000. Listed areas: alt-mempool-only apps; developer tooling (SDK, admission simulator, monitoring); breaking and improving rules (DoS, vulnerabilities, rules, simulators, fuzzers). Judging: creativity, usefulness, practicality, working quality, relation to the alt mempool. Qualifier: a link to an admitted devnet tx, OR code that submits one. The team must explain the design, code and trade-offs. At most one EF prize per project. No win odds are claimed.

v2 build-ready upgrade: 2026-11-06 08:45 IST. Local coding is authorized from this point. Public devnet use is still NOT authorized. §0 records what was verified in pinned source this morning and the build decisions it forces. §18 is the clock-time build plan. Product, track, verdict classes and the Must/Should/Cut list are unchanged.

## 0. v2: verified facts and build decisions

Facts below were read in pinned source on 2026-11-06 (sidecar `2e22ff0`, ethrex `9aa3645d`). Each one is a source reading, not a measured run.

| ID | Fact | Where |
|---|---|---|
| V1 | Sidecar `master` is still `2e22ff0`. The ethrex `eip8141-tracer` head is still `9aa3645d`. Both pins are current. | git |
| V2 | The reconciler runs from a `setInterval` cron every `bundleInterval` ms (default 10000), in every bundling mode. Each tick polls `getBlockNumber()` and skips if it is not above `lastReconciledBlock`. A pass runs in this order: Submitted receipts → mined-elsewhere lookups → recent roots → full re-simulation of `New` → `enforceBalances` → watch list. Ticks use `void tryBundle()`, so a slow pass can overlap the next tick. | `BundlingService/{service,reconciliation}.ts` |
| V3 | `enforceBalances` cancels `New` entries newest first by `submittedTime ?? lastUpdatedTime` (ms). The cancel reason includes `as of block N`. Balance accounting is wired to `publicClient.getBalance` in the real executor; unit tests skip it. | `MempoolService/service.ts`, `executor.ts:121` |
| V4 | Explorer `LifecycleEvent.blockNumber` is declared but reserved: no code path fills it. There is no "pass completed" event. | `docs/sidecar_explorer.md` |
| V5 | Per-sender cap for linear nonces is 4. The unstaked third-party payer cap is 10 (`SAME_UNSTAKED_ENTITY_MEMPOOL_COUNT`). S1's four txs fit; noise steps must not share S1's payer. | `MempoolService/constants.ts`, `ReputationService.ts` |
| V6 | `l1-hegota.json`: chain ID 9, every fork including Amsterdam and Hegota at time 0, genesis timestamp `1718040081`, 208 alloc entries. | ethrex `fixtures/genesis` |
| V7 | ethrex `--dev` mining fails on Hegota because its producer calls `forkchoiceUpdatedV4`, which rejects Hegota attributes. ethrex serves `engine_forkchoiceUpdatedV5` (attributes V5 = V4 + `inclusionListTransactions` + required `targetGasLimit`), `engine_getPayloadV6`, and `engine_newPayloadV6(payload, versionedHashes, parentBeaconBlockRoot, executionRequests, inclusionListTransactions)`. V5 attributes need `timestamp > parent.timestamp`; the caller chooses the timestamp. | ethrex `crates/blockchain/dev/block_producer.rs`, `rpc/engine/{fork_choice,payload}.rs` |
| V8 | The Kurtosis mining stack uses 6 s slots and activates Hegota at epoch 2 (about 6.4 min of slots after startup). Every fresh chain would cost minutes, which a reducer needing dozens of fresh runs cannot afford. | sidecar `test/e2e/kurtosis/eip8141-single-node.yaml` |
| V9 | Prebuilt images are `linux/amd64` only. Self-contained devnet image: `ghcr.io/forshtat/eip8141-devnet:9aa3645d…` at `sha256:c9a7770f…2224c6`. ethrex does not build natively on macOS. | ghcr manifest, `ethrex-devnet.sh` |
| V10 | The relay submits signed bytes through `ethrex_submitPrivilegedFrameTransaction`, which at this pin accepts an optional target block. Manual mode relays only on `debug_bundler_sendBundleNow`. | `BundlingService/service.ts`, ethrex commit `9aa3645d` |
| V11 | Frame txs carry a list of signer entries. EOAs without code run built-in default code in VERIFY frames. An EOA payer is therefore plausible for S1, but this is unverified until G5. | ethrex `docs/eip-8141.md` |
| V12 | Measured: the published `amd64` image does not start under Rosetta on this machine. No RPC after more than 5 min; even `ethrex --version` did not return in 90 s. Rosetta reports no AVX/BMI2. The image digest in V9 is therefore recorded but not run. G1 runs a local `linux/arm64` build of the same commit `9aa3645d` from ethrex's own Dockerfile (`PROFILE=release-fast`, `-p ethrex --bin ethrex`), tagged `framelab/ethrex:9aa3645d-arm64-release-fast`. Its image ID goes into `node_pin`. The genesis file is byte-identical (sha256 `5fe93acb…1fb4`) to the published image's copy. | local run, `docker buildx` |
| V13 | The sidecar e2e helper comment that reconciliation runs only in auto mode is stale: the constructor and `setBundlingMode` both call `restartCron`, so V2 holds in manual mode. Code wins over the comment. | `BundlingService/service.ts` |
| V15 | Measured: at this pin, ethrex answers every `engine_forkchoiceUpdated` with `SYNCING` in its default snap sync mode. The stepper needs `--syncmode full`. | G2 run, `src/env/ethrex.ts` |
| V16 | Measured: this fork charges state gas. A plain ETH transfer to a fresh account needs 207,391 gas, so a fixed 21,000 fails. FrameLab estimates gas for every normal tx. A SENDER frame that pays a fresh account reverts under its state limit of 0, so fixtures pay existing accounts (S1 and S2 fund `sink` with 1 wei). | G3 and G2 runs, `.runs/probe-gas.ts` |
| V17 | Measured timings on this machine: ethrex container start 0.4–1.5 s; whole-stack reset (ethrex + sidecar + capability check) 2.1–3.0 s; one stepped block about 0.31 s; frame simulation 7–14 ms; one S1 run 11–12 s wall; one S2 run 19–20 s; the first G6 shrink took 340 s for 20 node-tested candidates. | `meta.json` of each run |
| V14 | §5.4 lists "zero assertions" as UNRESOLVED. In S1, deleting any payer tx makes every remaining payer assertion's preconditions false. Once the control is also gone, no assertion executes, so those single deletions are unresolved and the reducer cannot claim 1-minimality for this fixture. It reports this instead of reinterpreting the rule. | `framelab/test/reducer.test.ts` |

Local machine (measured): Apple Silicon, 8 CPU, 8 GB RAM, about 30 GB free disk. Docker is installed but was not running. Kurtosis is not installed. Node 22, Bun 1.3, Rust 1.93 and `gh` are present.

Decisions forced by these facts:

- **D1 Block driver: FrameLab engine stepper (primary).** Run one ethrex container from the pinned digest with `l1-hegota.json`. Do not use `--dev`. Expose auth RPC with a per-run JWT. A FrameLab module calls `forkchoiceUpdatedV5` (with attributes) → `getPayloadV6` → `newPayloadV6` (empty inclusion list) → `forkchoiceUpdatedV5` (new head). Block `n` gets timestamp `genesis + 12·n` and slot `n`. This is a single-node payload stepper on ethrex's own engine API, like ethrex's dev producer. It is NOT new consensus tooling: no beacon state, no fork choice, no networking. Timebox: 45 minutes inside G2/G3. If it cannot produce a VALID Hegota block by then, fall back to D2.
- **D2 Fallback: Kurtosis mining stack** for G2 inclusion evidence and the demo only. It cannot support the reducer because of the multi-minute start (V8). If D1 fails, reduction runs only if a fresh-environment cost under about 60 s is measured some other way; otherwise ship the labelled OFFLINE ANALYZER (§9).
- **D3 One block per completed pass.** The stepper produces block N+1 only after the completion signal for block N (D4) or a recorded timeout. This rules out the overlapping-pass case in V2, and it keeps checkpoints aligned to blocks.
- **D4 Completion signal: labelled observation patch.** The sidecar does not report pass completion (V4). Apply `patches/sidecar-observe.patch`: one structured log line when `reconcile()` returns, naming the block it reconciled. The patch changes no policy. Apply it identically to the baseline build and the injected-regression build, and record its hash in `node_pin`. If the line never arrives for a block, affected stale-kept assertions are INCONCLUSIVE.
- **D5 Sidecar run config.** `standalone`, `--executor.bundlingMode manual`, `--explorer.enable`, a fresh `--dataDir` per run, `bundleInterval` small enough for speed (start at 250 ms; tune at G3), `useropsTTL` large enough that TTL never fires inside a scenario, and a public TEST-ONLY relayer key. Record all of it as the sanitized config hash.
- **D6 Stack.** TypeScript on Bun for the runner and CLI; `viem` for RPC and signing; YAML/JSON scenarios validated against a JSON Schema. Extract only the needed MIT helpers (`buildUnsignedFrameTx`, `signFrameTx`, `toWire`, `computeSigHash`) into `src/vendor/sidecar/` with the Etherspot notice. The viewer is one static HTML file that reads a bundle locally.
- **D7 Reset.** `docker rm -f` the ethrex container (ephemeral datadir), kill the sidecar process, delete its `--dataDir`, and start both again. Measure wall time at G3. That number sets the reducer budget.
- **D8 Reduced scenarios drop inapplicable assertions (v2.2).** After the final confirmation, a non-target expectation whose preconditions were measured false on both final runs is removed from `scenario.min.yaml` and listed in `reduction.json` as `pruned_expectations`. The same evidence is re-judged without it, and the target must still be interesting. No expected fate is ever edited. Otherwise every replay of the reduced case is INCONCLUSIVE by §5's rule even though the target reproduces. The reduced description states its origin and that copied derivations may mention removed steps.
- **D9 Wrong test expectations are declared (v2.2).** The oracle cannot tell a wrong expectation from a node bug. Acceptance test 2's fixture marks its flipped expectation `deliberately_wrong: true`; its mismatch is then `ASSERTION_MISMATCH` with the reason "wrong test expectation". Every bundle README says a mismatch alone does not show a node bug.
- **D10 Negative-path faults (v2.2).** `framelab run --fault skip-checkpoint|sidecar-down|sidecar-restart@<checkpoint>` and `--run2-patch` break a real run on purpose for acceptance test 3. Faulted and mixed-build runs are recorded in `meta.json` and `verdicts.json`, and `export` refuses them.

## 1. One-line definition

**FrameLab is a release-check workbench for alt-mempool nodes.** Write what should happen to pending frame transactions when the chain changes. Replay the sequence on a pinned local node twice as a consistency check. Read expected versus actual at each checkpoint. Shrink a mismatch to the smallest replayable case found. Export CI evidence, then rerun after a fix.

## 2. User and job

1. Primary user: an alt-mempool node developer. First target: the workshop sidecar, not all ERC-8421 clients.
2. Job: “Check a change to admission, revalidation or eviction. Show the first wrong outcome and give me a replayable regression.” A PASS covers the assertions run, not the whole client.
3. Secondary user: a rule author checking draft changes. Draft comparison is SHOULD, not part of the first required loop.
4. Prior art is close. The sidecar already re-simulates eligible `New` entries on each observed new block. It has a rule-by-rule explorer, balance eviction tests, cancellation e2e tests, and keyed-nonce tests. Do not rebuild its explorer or claim revalidation is missing [R3].
5. bundler-spec-tests is more than per-rule admission. It tests replacement, reputation, multiple senders and post-bundle pending contents. Its `find_min.py` searches gas fields; it is not a sequence reducer [R5].
6. EELS/EEST already has versioned block-sequence fixtures and EIP-8141 / 8250 tests, including live-RPC keyed blob submission. Generic replay, sequence tests and conformance suites are not new [R10].
7. Narrow intended contribution: one workflow for the pinned sidecar's pending-tx lifecycle: explicit rule-backed checkpoint assertions → mismatch explanation → same-predicate real-node reduction → CI bundle → fix comparison. This combination was not found in the named files in §17. That is not a claim of absence across repositories or the ecosystem.

## 3. Value without an upstream bug

1. A small, reusable corpus of pending-transaction lifecycle cases. Start with payer obligations and a storage dependency. Do not claim these cases cannot be tested any other way.
2. A mismatch has a cited policy, measured checkpoint and raw evidence. Expected invalidation is useful evidence, not a vulnerability.
3. A reduced bundle lets another developer check the same assertion without the UI.
4. SHOULD: compare compatible rule versions and report draft divergence. SHOULD: show evictions per trigger gas as an observation. Neither feature is needed to prove the core loop.

## 4. Core model and oracle

1. **Scenario:** public TEST-ONLY actors, local fixture contracts, ordered steps, and checkpoint expectations. Supported first: `submit`, state change through a normal transaction, and `advance-to-checkpoint`. Replacement, stake changes and recent-root cases are SHOULD/future.
2. **Fate:** `admitted | rejected | pending | evicted | included(success|revert) | replaced`. Preserve the raw sidecar status and receipt beside the normalized fate. `Submitted` means sent to the execution client, not included. A missing hash is not proof of eviction. `included` in the explorer includes reverted execution [R3].
3. **Expectation:** `{assertion_id, tx_role, checkpoint_id, expected, rule_ref, preconditions, evidence_required}`. A rule reference stores URL, immutable source revision or content hash, section, short exact quote, and strength (`MUST`, `SHOULD`, `MAY`, or implementation policy).
4. Each expectation has a short derivation: pre-state → allowed dependency → state change → applicable written requirement → expected outcome by checkpoint. Admission reports explain what the node thought; they do not set the expected answer. No AI in the oracle.
5. Sidecar policy and ERC text are separate authorities. Ship `sidecar-policy@2e22ff0` first. It cites source functions plus the earlier draft provenance, `forshtat/ERCs` PR #6 at `74a868cd`, where relevant. Do not relabel sidecar IDs as ERC-8421 IDs [R2–R4].
6. ERC-8421 comparison is SHOULD. The audit opened PR #2028 at `493ba8ac3be97dc5cf6335eb97d2e8e9f95983c5`. Store that revision and the rule text hash, not `PR2028` alone. A moving PR is not a version pin.
7. Compatibility is checked before assertions. The workshop ethrex targets EIP-8141 `4a9ad32cf`; today's EIP uses a different aggregate fee field and signature-hash rules. Current EELS Bogota fixtures are also newer. Do not run them unchanged on this old codec, or call encoding failures lifecycle bugs. A non-applicable pack reports INCONCLUSIVE with the compatibility reason. A future adapter migration is outside this hack [R4, R10].

Verdict classes:

- `PASS`: the reached assertion matches its supported expectation.
- `EXPECTED_INVALIDATION`: the applicable rule requires the observed invalidation. Never a failure or vulnerability.
- `STALE_KEPT`: candidate failure only if the selected rule requires eviction or handling, its preconditions hold, and the tx is still pending after the measured required checkpoint. A reverted inclusion alone is not a mempool bug.
- `WRONGLY_EVICTED`: candidate failure only if the selected policy requires keeping or handling this valid tx and allowed TTL, resource, replacement and local-policy reasons are excluded. Validity alone does not forbid all eviction.
- `SPEC_DIVERGENCE`: the evidence supports one compatible policy but not another. Not automatically a bug. Show which policy the node claims to implement.
- `INCONCLUSIVE`: zero executed assertions; missing data; unsupported pack; lost history; timeout; unreachable checkpoint; or disagreement between double-runs. Never green.

Run summary: retain per-assertion results. Green requires all required assertions reached, at least one executed, no required data missing, and both runs consistent. If any required assertion is inconclusive, the overall run is inconclusive; still show any observed mismatches. A deliberately wrong expectation is an assertion mismatch, not evidence of a node vulnerability.

## 5. Pipeline and contracts

```
Versioned scenario + frozen expectations
          │
          ▼
Runner ──► Node adapter ──► isolated ethrex + sidecar
  │            │                  │
  │       capability check        │
  ▼                               ▼
raw RPC/log evidence ──► normalized events ──► cited oracle
                                               │
                           same failure predicate
                                               ▼
                                  bounded reducer
                                               │
                                               ▼
                              bundle → CLI / timeline / CI
```

### 5.1 Scenario: small fixture, not a new language [R6, R10]

1. Keep `framelab.scenario/v1` in JSON or YAML. Top-level fields: `id`, `description`, `seed`, `rule_pack`, `protocol_revisions`, `node_pin`, `genesis`, `actors`, `fixtures`, `steps`, `expectations`, `limits`.
2. `node_pin`: full sidecar and ethrex commits; image digests if used; sanitized config hash; dependency lock hash. `genesis`: allocation/code hash, chain ID and fork schedule. Store fixture bytecode hashes and public actor derivation version.
3. Steps use stable IDs, role names and explicit `depends_on` IDs. Expectations are written before the run. Keep pre-state and expected checkpoint outcomes apart from observed output. Do not fill the expected oracle from the same node under test.
4. Limits state maximum scenario time, checkpoint wait, candidate attempts and shrink wall time. Record the chosen values. Choose them at G3 from measured local run cost; no performance promise before that.
5. EEST inspires pre-state → sequence → expected state and versioned forks. This is a FrameLab lifecycle format, NOT an EEST-compatible fixture or a full consensus oracle.

### 5.2 Adapter: expose only what is proved [R3, R4, R11]

1. Interface intent: `start/reset / capabilities / submit / advance-to-checkpoint / pool / status / receipt / admissions / lifecycle`. `snapshot/revert` is optional, not assumed. The selected driver must prove block control at G3.
2. RPCs: `eth_sendFrameTransaction`, `skandha_frameTransactionStatus`, `eth_getFrameTransactionReceipt`, `skandha_explorer_info`, `skandha_explorer_getTransaction`, `skandha_explorer_listAdmissions`, `skandha_explorer_listTransactions`.
3. Enable `--explorer.enable`; otherwise explorer methods return method-not-found. Fetch `bootId`, `oldestSeq`, `latestSeq` first. Drain all pages with the returned cursor. Save evidence during the run: history is bounded and in memory. A restart or sequence gap makes affected assertions INCONCLUSIVE, not silently complete.
4. Use manual **relay** mode to keep candidate frame txs pending. It does NOT stop the chain or the reconciler. `tryBundle()` runs reconciliation before it checks manual mode. Do not equate `debug_bundler_sendBundleNow` with mining a block.
5. Important setup trap: `test/e2e/ethrex-devnet.sh` runs a non-mining admission network. The separate `ethrex-mining-devnet.sh` uses ethrex + Lighthouse through pinned ethereum-package, with staged forks. It proves a mined environment, not on-demand mining or snapshot support. G3 must establish a supported local block/checkpoint driver within the gate; do not invent `evm_mine` support. If it cannot, use the labelled offline fallback. v2: the driver is the D1 engine stepper over the non-mining single-container setup. The non-mining script fails only because ethrex's dev producer picks `forkchoiceUpdatedV4` (V7). The Kurtosis stack is the D2 fallback only.
6. Reuse MIT-licensed sidecar helpers at the pin: `buildUnsignedFrameTx`, `signFrameTx`, `toWire` from `test/e2e/helpers.ts`, and `computeSigHash` from `packages/executor/src/services/FrameTxService/codec.ts`. Preserve the Etherspot copyright and MIT notice. Import/extract only needed helpers; do not start their test harness as a side effect. No workshop code copy without its own license check.

### 5.3 Runner and checkpoints [R3, R11, R13, R15]

1. Reset the **whole** environment between runs and shrink candidates: chain, sidecar DB, reputation, pending obligations, in-memory reconciler and history. An EL snapshot alone does not reset the sidecar. Fresh isolated data directories are the default; coordinated snapshots only if G3 proves them.
2. Steps wait for their named condition. Admission-only steps do not wait for a new block. A state-change checkpoint requires the trigger receipt, its block identity, and evidence that the relevant reconciliation work finished against that head.
3. Block height plus elapsed time is not proof of reconciliation completion. The inspected explorer has no explicit pass-completed event. G4 must prove a local completion signal (for example a verified local test hook/driver or suitable logs). Do not infer completion from the expected failure itself. If no signal exists, stale-kept assertions stay INCONCLUSIVE; do not turn a timeout into a violation. v2: the signal is the D4 observation patch, plus D3 (no next block until the pass for this block completes). A completion line for block N proves `reconcileNew` and `enforceBalances` finished for N. It does not prove anything about passes the sidecar skipped.
4. Record raw responses and event order: `{run, step_id, checkpoint_id, block_number, block_hash, tx_role, tx_hash, raw_status, fate, source, raw}`. Capture chain state needed for the assertion, not every possible trace.
5. Run each case twice. Compare an explicit semantic projection: ordered roles and actions, relative checkpoint blocks, required pre/post values, fates, rule results and coverage. Preserve raw hashes, wall times and logs separately. List fields excluded from comparison; never normalize away a fate, required dependency value or failed assertion. If exact block/tx hashes are claimed equal, verify them too.
6. Use fixed seeds and genesis, a controlled driver, and fixed timestamps only where supported. Two matching runs are a consistency check, not proof of determinism and not rr-style instruction replay. “Fix → rerun” is a new execution, not playback of saved events.

### 5.4 Reducer: dependency-aware ddmin [R6–R9]

1. Freeze the target: `assertion_id + verdict class + tx_role + rule_ref + checkpoint condition`. Freeze the rule pack, node build and expected answer. The target tx must first be admitted when the scenario requires it.
2. Use ddmin-style chunk deletion over ordered step groups. Increase granularity when no deletion works. Then remove unused actor/fixture groups with their dependent steps. This is structure-aware deletion inspired by HDD, not a claim to implement the full HDD algorithm.
3. Keep dependencies explicit. Reject orphaned or invalid candidates before a node run. MUST first implement deletion only. Optional nonce repair is narrow: rebuild declared sequential nonces and signatures from the same actor roles, log the repair, and preserve the targeted admission/state-change relationship. Never repair expectations, fee policy, nonce-key meaning or required state preconditions to force a failure.
4. “Interesting” means the SAME predicate holds in two fresh real-node reruns, with required assertions reached and no missing evidence. An unrelated admission rejection, crash, timeout, zero assertions or different mismatch is UNRESOLVED for reduction, never a successful shrink.
5. Keep the best confirmed case after each accepted deletion. Cache by candidate + pins + rule hash + reset/driver configuration. Save candidate outcomes and stop reason. Reserve budget for a final fresh two-run confirmation; cached success alone is not final evidence.
6. Report “smallest found,” original/reduced counts, attempted/kept/unresolved counts and budget used. Not global minimum; not even 1-minimal unless all permitted single deletions were tested. Stop/cancel exports the best confirmed result, not a half-tested candidate.
7. Numeric/fixture-field simplification is SHOULD only. Random fuzzing, compiler reduction passes, and a generic reducer plug-in framework are CUT.

### 5.5 Evidence bundle and CI [R8–R12, R14]

1. Required files: `manifest.json`, `scenario.original.yaml`, `scenario.min.yaml` when confirmed, `events.run1.jsonl`, `events.run2.jsonl`, `verdicts.json`, `node_pin.json`, `rule_pack.json`, sanitized raw evidence, `reduction.json`, `replay.sh`, `README.md`. When no shrink ran, state that; do not invent a min file.
2. Manifest: schema/tool version, scenario ID/hash, rule source revision/hash, genesis and fork schedule, exact node/image/dependency pins, driver and reset method, capability results, run IDs, completion/coverage counts, source mode (`real-node` or `offline`), injected-regression label, and hashes of bundle files. Hashes help detect changes; they do not prove the oracle is correct.
3. README: prerequisites, exact local command and config, expected assertion/verdict, known limits, public test-key warning and license credits. Replay consumes the frozen scenario without the UI. No silent “latest” dependencies or ambient machine paths.
4. CLI: exit `0` only for complete consistent PASS/EXPECTED_INVALIDATION under the selected pack; `1` for a confirmed assertion mismatch; `2` for incomplete/inconclusive/unsupported input or target. Keep detailed classes in JSON. A compatible draft comparison that contradicts the selected target expectation is non-green; show the divergence reason separately. An unsupported pack uses exit 2, not a mismatch.
5. Exclude non-test secrets, RPC credentials and the qualifying-tx key. Exported seed keys are PUBLIC TEST-ONLY by design. Use an allowlist and a content scan; a grep alone is not proof that there is no secret.
6. Preserve raw evidence, but do not export secrets first and hope the UI redacts them. Normalize only non-semantic comparison fields. Do not auto-approve changed outcomes in CI. A fix comparison freezes scenario + oracle and records old and new node build hashes separately.
7. SHOULD: vitest wrapper in the sidecar e2e style. The required CLI replay already is the regression export; generated test code is not required to complete the loop.

## 6. User flow

1. Select a pinned target and supported rule pack. Read capability and compatibility results.
2. Open S1 or S2 as a file. Edit steps and rule-backed expectations. Guided builder is CUT.
3. Run twice on clean local state. Show “Run 1/2” and the checkpoint being awaited.
4. Open the first mismatching checkpoint. Read expected, actual, source quote, measured state and raw RPC evidence together.
5. Select Shrink. Show “smallest found,” the unchanged target assertion, and the original-to-reduced diff.
6. Export. Rerun from a clean environment. After a node fix, compare with the old run using the same scenario and oracle.

## 7. UI states (exactly eight)

1. **Empty:** no target. Primary: “Start local network”. Secondary: open a saved bundle.
2. **Ready:** show pins, rule pack, compatibility, capabilities and block height. Primary: “Run scenario”.
3. **Running:** show run 1/2, current action and checkpoint wait. Primary: “Cancel”.
4. **Pass:** only complete, nonzero assertions and consistent runs. Show assertions reached/declared and rules exercised. Primary: “Export regression”.
5. **Fail:** select the first mismatching cell. Show assertion ID, expected/actual, applicability and exact quote. Primary: “Shrink”. Disable it if the predicate is not reproducible.
6. **Shrinking:** show attempted/kept/unresolved candidates and remaining budget. Primary: “Stop and keep best”.
7. **Inconclusive:** grey; state the missing fact, not “probably fine”. Primary: “View raw evidence”.
8. **Spec divergence:** amber; compare compatible packs and name the target policy. Primary: “Inspect rule difference”. Only reachable if that SHOULD feature is built; do not fake a screenshot.

Trace-viewer lesson [R12]: one view, not a dashboard. Put steps/blocks across and tx roles down. Selecting a cell links before/after state, expected/actual, rule text and the raw call. Keep run and checkpoint IDs visible. An exported bundle opens locally without uploading it. No screenshot filmstrip, wallet UI, fake metrics or rebuilt sidecar explorer.

## 8. Seed corpus (two MUST; third SHOULD)

1. **S1: payer obligation drop.** Four pending txs share a payer, on distinct senders or non-conflicting keys. Admit them before a normal trigger tx reduces the payer balance. Choose remaining balance above each individual max cost, but below their sum, to isolate aggregate eviction from individual simulation failure. Capture each max-cost obligation and ordering. Under `enforceBalances`, newest `New` entries are cancelled only until the remaining sum fits. `Submitted` obligations count but that function leaves them alone. Full reconciliation first processes `Submitted` and re-simulates `New`; do not claim “Submitted is always retained” or all failures come from balance enforcement [R3]. Require unambiguous admission times or avoid asserting a tie order. An unaffected control stays pending if the selected policy requires it. v2 fixture: payer is an EOA (V11) and the trigger is a plain ETH transfer out of it. If EOA payment approval fails at G5, use a fixture payer contract: APPROVE(PAYMENT) in VERIFY, and an owner-only withdraw path for the trigger. Space admissions at least 50 ms apart (V3), and keep the payer below the cap of 10 (V5). v2.1 fixture (built): one self-paying EOA sends four `self_verify` txs on nonce keys 1–4 (sequence 0 each), so they never conflict and the linear cap does not apply. The control is a separate EOA on key 0. Each obligation is the EL-simulated `maxCost` plus the 1 wei value, captured per tx from `ethrex_simulateFrameTransaction`, not from the sidecar under test. The drain leaves 2.5× tx1's max cost, so the newest-first set is {tx4, tx3}. A third-party EOA payer is not needed for S1; it stays unverified.
2. **S2: allowed storage dependency changes.** A VERIFY frame reads a slot whose access is allowed under the selected stake/association rules. Prove admission and the dependency before a normal actor tx changes it so VERIFY no longer approves. At a measured completed pass, expect cancellation under the pinned reconciler policy. Cite ERC `LIFECYCLE-040` only in its own applicable pack. If admission was forbidden or the pass cannot be measured, report INCONCLUSIVE; that is not a stale-kept result.
3. **S3: keyed replacement, SHOULD.** `[1,3,5] → [1,5]` at one sequence is described as a replacement by ERC-8421. But the pinned sidecar only fee-replaces the exact key set; overlapping different sets are rejected in `keyedNonces.test.ts`. This is a documented policy difference, not a predicted upstream bug. A supported test can assert that rejection. Current-ERC cross-pack execution needs a compatible protocol substrate, not just renamed rule IDs.
4. Every corpus entry has a source map and explicit checkpoints. Reuse cases; do not promise exhaustive lifecycle coverage. Recent-root expiry, stake transitions and larger corpus are future/SHOULD only.

## 9. Proof gate G1–G6 (first 2–3 build hours)

- **G1 Environment:** start pinned isolated ethrex + sidecar; `eth_chainId` answers. Save client version, genesis hash, fork schedule and image digest. Use the documented mining stack for mining; the fast admission fixture alone is insufficient. v2: G1 uses the D1 container (pinned digest, `amd64` under emulation, V9) plus a sidecar built from source at the pin. Also record ethrex startup time and one `ethrex_simulateFrameTransaction` latency under emulation; they set later timeouts. Mining moves to G3 through the stepper.
- **G2 Real tx:** one frame tx admitted, then included with a receipt and explorer record. The privileged local relay bypasses ethrex's canonical admission; label this path. It is evidence of local alt-mempool admission/inclusion, not canonical-mempool conformance.
- **G3 Control:** prove fresh chain + fresh sidecar reset, a normal fixture-state mutation, and a supported controlled block/checkpoint driver. Repeat the same semantic action/block sequence twice. Record unsupported timestamp/snapshot controls. Do not spend the remaining hack building a new consensus driver. v2: the D1 stepper must produce a VALID Hegota block containing the trigger tx within its 45-minute timebox. Measure full reset wall time (D7). Pass bar: two fresh runs give the same block numbers and timestamps for the same step list.
- **G4 Observe:** measure completion of the relevant reconciliation against the trigger head independently of whether the target passes. Capture status + lifecycle + chain state. Restart, history gap or missing pass evidence must be detected. v2: pass evidence is the D4 completion line; restart is a changed explorer `bootId`; gap is `sinceSeq + 1 < oldestSeq`.
- **G5 Assert:** S1 runs with at least one reached rule-backed automated assertion and correct PASS/EXPECTED_INVALIDATION. Test a missing-data path too: it must not go green.
- **G6 Shrink:** on a LOCAL deliberately injected node regression, label the mutation/build hash. Pad S1 with ten removable noise steps. Produce a smaller case with the same predicate, confirmed on two fresh real-node runs. At most three action steps is a target for this fixture only; setup is reported separately, not hidden. No global-minimum claim. v2.1: the injected mutation is `patches/inject-s1-oldest-first.patch` (sha256 `7b0635dd…b5d9`), which reverses the `enforceBalances` sort to oldest first. Under it, any reproduction needs three payer submits plus the drain, because two obligations fit inside 2.5× one max cost. The expected smallest case is therefore four action steps, and the report will say so rather than retune the fixture to reach three.

If G3–G4 fail, fall back to a clearly labelled **OFFLINE ANALYZER** over recorded logs. It can inspect the oracle and timeline. It cannot claim real-node sequence replay, validated minimization or a replayable regression from deleted log entries. Do not claim the main release gate shipped. Same product family; no new idea without Shubham. No public devnet action during this audit. Later qualifying use needs code authorization and allowed devnet use.

## 10. Must / Should / Cut

Deadline: Nov 7 09:00 IST. Planning envelope: about 25 hours gross; 6 hours sleep + 3 hours buffer + 2 hours demo/submission leaves about 14 build hours. The gate is inside that budget. This is an envelope, not a fresh 14-hour grant after research or delays. Recompute remaining time when coding is authorized.

v2 recompute at 08:45 IST: 24 h 15 min to deadline − 6 h sleep − 2 h demo/submission = 16 h 15 min. 13 h build leaves 3 h 15 min for breaks, buffer and the acceptance run. Clock times are in §18.

MUST, incremental time after each prior step (v2 total 13 hours; was 14):

1. G1–G6 thin vertical proof: 3 h.
2. Harden adapter, reset, fixture and runner: 2.5 h (was 3 h; the stepper and reset are built in the gate).
3. Sidecar-policy oracle, S1 + S2, negative paths: 2.5 h.
4. Bounded deletion reducer and predicate checks: 2 h.
5. Bundle, exact replay command and CLI outcomes: 1.5 h.
6. Minimal timeline bundle viewer: 1.5 h (was 2 h; it is first in the cut order anyway).

The gate builds a thin slice; do not rebuild that slice in each later estimate. These are estimates, not executed timings.

SHOULD only replaces lower-priority work; it adds no hours: compatible ERC pack + S3, vitest wrapper, amplification observation, numeric simplification. Cut UI polish, then UI entirely, before the runner, oracle, reducer or evidence. CLI + readable bundle is the hard floor. Guided builder, random fuzzer, multi-node gossip, hosted service, other-client adapters, full trace debugger and new consensus tooling are CUT.

## 11. Acceptance tests

1. Fresh S1: exit 0, at least one reached assertion, all required checkpoints observed, and both semantic projections agree. Expected invalidation is not red.
2. Deliberately flip one expectation: exit 1 at the correct assertion. Label “wrong test expectation”; never call this an injected node bug.
3. Zero assertions, a skipped required checkpoint, transport failure, pass timeout, restart/history gap and inconsistent double-runs each yield INCONCLUSIVE/exit 2. Never green. Test these independently.
4. Labelled injected node regression: same assertion fails on both runs. Deletion must reject a candidate that merely fails admission, loses the target assertion or produces another failure class. Final smallest-found case fails on two fresh real-node reruns.
5. `replay.sh` consumes the bundle on a clean pinned environment without the UI. Tampered/missing pins or fixture hashes stop replay with a clear error.
6. Bundle export uses an allowlist plus a secret scan. It contains no non-test secret, credential or qualifying key. Its seed-derived keys are explicitly public and TEST-ONLY.
7. Fix comparison: unchanged scenario + rule hash, separate old/new node pins; mismatch before, complete consistent pass after. Never “accept actual” to create the pass.
8. UI exercises all built states from actual runs. Running and Shrinking come from real progress; outcome bundles drive Pass, Fail and Inconclusive. Keep eight state definitions, but mark unbuilt optional Spec divergence as unbuilt rather than inventing data.
9. Unsupported current-ERC/new-codec combinations are INCONCLUSIVE, not false conformance failures. A valid tx removed by an allowed policy is not automatically WRONGLY_EVICTED.

## 12. At most three-minute demo

Use only the actual final run. Do not script success numbers before execution.

1. 0:00–0:20: “Pending transactions can become invalid. Sometimes that is correct. FrameLab checks the written policy at a measured checkpoint.”
2. 0:20–1:10: S1. Open an expected eviction and its rule/source. Show an unaffected control if built. Amplification only if implemented and measured; it stays an observation.
3. 1:10–2:00: labelled local injected S1 regression → first mismatch → Shrink → smaller confirmed repro → export. Use the same case as G6, not an unbuilt S2 switch.
4. 2:00–2:30: fix build → same bundle and oracle → complete pass. Show old/new pins and actual counts.
5. 2:30–3:00: qualifying admitted devnet link only if later authorized and obtained; otherwise show actual submission code, as the prize permits. Future: versioned lifecycle corpus. Omit S3 unless built and applicable. Offline mode must be described as offline, not staged as a live replay.

## 13. Risks and trust

1. Highest risk: controlled mining + whole-stack reset + pass observability. The existing fast e2e stack does not solve these. G3–G4 decide feasibility before polish. v2 specifics: (a) the D1 stepper may hit an engine-API detail the dev producer never exercised on Hegota (FOCIL retention, BAL, execution requests); (b) `amd64` emulation on Apple Silicon may make each simulation slow; (c) 8 GB RAM leaves little room for Docker plus a sidecar build; (d) `bundleInterval` polling adds latency to every checkpoint.
2. The oracle is a human interpretation of a cited policy. Evidence and a pure oracle make it reviewable, not trustless or formally proved. No “no trust hole” claim.
3. Matching runs do not eliminate nondeterminism. Clock-based TTL, tied admission times, CL timing and recent roots can change results. Record controls and limits.
4. No upstream mismatch may be found. The tool remains useful; the demo uses a labelled injected regression. Never present it as an upstream vulnerability.
5. Results apply to the pinned local build/config only, not the public network or every client. A full-sweep reconciler is existing behavior; this hack does not claim to implement or benchmark dependency-filtered revalidation.
6. Docs have known drift and an AI-generated-content warning. The workshop README says there is a faucet; the docs devnet guide says there is none. Public funding/health is unverified. Prefer pinned source and measured capability, and keep the uncertainty in the README.

## 14. Safety and license

1. Run on an isolated, disposable local chain only. Bind debug/privileged RPC to the local environment. No public spam or public admin changes.
2. Exported actor seed keys are public TEST-ONLY keys. Anyone can recover them. Never fund or use them on any other network.
3. If a future private fixture needs secrets, keep them outside the bundle and replay through an explicit remap. Do not call seed-derived keys secret.
4. A later qualifying devnet tx uses a separate throwaway key, not derived from an exported seed. No secret is exported. Check allowed devnet use and get code authorization first.
5. Reuse the pinned sidecar's MIT helpers with attribution and the notice. Write new FrameLab project logic during Classic. No copying unlicensed workshop code or GPL Hive implementation into this hack.
6. No outreach. Any real finding goes to maintainers only with Shubham's approval. No code was written or launched in this audit. v2: local coding started 2026-11-06 08:45 IST. Upstream sources are cloned read-only under `../vendor/` and are not part of the FrameLab repo.

## 15. Future (not hack scope)

A shared versioned lifecycle corpus; rule-pack review with editors; compatible client adapters; nightly sequence generation feeding the reducer; and dependency-filtering load studies. Reuse Ethereum conformance formats where appropriate. Do not call FrameLab the first sequence-testing tool.

## 16. References and what we took

All entries below were opened during this audit. Each changes a decision above. “Not copied” is a scope or trust boundary, not dismissal of the source.

1. **R1 — Prize contract.** [ETHGlobal Mumbai prizes](https://ethglobal.com/events/mumbai/prizes), EF alt-mempool section and EF one-prize rule. Better job: exact qualification. Taken: §12 permits submission code instead of requiring an unauthorized broadcast; preserve pool, judging and one-EF-prize limit. Not copied: unrelated sponsor integrations.
2. **R2 — Normative rule text.** [ERC-8421 at 493ba8ac](https://github.com/ethereum/ERCs/blob/493ba8ac3be97dc5cf6335eb97d2e8e9f95983c5/ERCS/erc-8421.md), Motivation, Definitions, SOLVENCY, LIFECYCLE-010…040 and Security. Better job: states obligations and limits. Taken: §4 exact quote + strength + immutable pin; §8 keyed-replacement distinction; amplification stays an observation. Not copied: treating a draft, a SHOULD, or security rationale as a proven vulnerability oracle.
3. **R3 — Closest implementation.** [Sidecar at 2e22ff0](https://github.com/forshtat/mempool-workshop-sidecar/tree/2e22ff0a2898e69ea4bf5275bce1be8581a8582a): `README.md`, `LICENSE`, `packages/executor/src/services/BundlingService/{reconciliation,service}.ts`, `MempoolService/service.ts`, its balance/keyed tests, reconciler tests, `test/e2e/{helpers,frameTxCancellation.e2e.test,frameTxSharedSender.e2e.test}.ts`, and `docs/sidecar_explorer.md` plus explorer module. Default `master` resolved to the same commit. Better job: real status semantics and tested policy. Taken: §5 manual relay is not mining, full reset, bounded-history capture, helper reuse; §8 isolates aggregate balance eviction. Not copied: explorer dashboard or claims that revalidation is absent.
4. **R4 — Compatibility and setup.** [Docs differences](https://docs.altmempool.wtf/project/differences/), [RPC](https://docs.altmempool.wtf/reference/rpc-methods/), [explorer API](https://docs.altmempool.wtf/reference/explorer-api/), [run sidecar](https://docs.altmempool.wtf/guides/run-the-sidecar/), [devnet](https://docs.altmempool.wtf/guides/devnet/); [workshop README at bcfe02a](https://github.com/forshtat/mempool-workshop/blob/bcfe02a196ca97b6fb0d1044db9d0b4c673831fc/README.md); sidecar `test/e2e/ethrex-devnet.sh` and `ethrex-mining-devnet.sh`; [ethrex notes at 9aa3645d](https://github.com/forshtat/ethrex/blob/9aa3645d795945c64400f41a70aace0edfa7f383/docs/eip-8141.md); [current EIP-8141](https://eips.ethereum.org/EIPS/eip-8141), encoding, signature hash, Mempool/Revalidation. Better job: explains revision and environment limits. Taken: §4 compatibility matrix; §9 mining/control gate; §13 funding-doc conflict. Not copied: open public admin methods, mutable `latest` images or experimental solc path. Ethrex branch resolved to 9aa3645d; live deployment was not checked.
5. **R5 — Existing AA suite.** [bundler-spec-tests at 17bd608d](https://github.com/eth-infinitism/bundler-spec-tests/tree/17bd608d96bc4676a5fdb9fda1a5d9dfaac0a38e): `tests/find_min.py`, `single/reputation/test_replace.py`, `test_reputation.py`, `single/bundle/test_bundle.py`, and `single/rpc/test_eth_sendUserOperation.py`. Better job: stateful replacement/reputation assertions and manual bundling. Taken: §2 narrows prior-art claim; corpus checks post-step pending contents, not just submission errors. Not copied: EntryPoint/UserOperation APIs or gas-field minimizer as a sequence shrinker.
6. **R6 — Preserve invariants while shrinking.** [Hypothesis: Integrated vs type-based shrinking](https://hypothesis.works/articles/integrated-shrinking/), full author article and even-number failure example; [Strategies Reference](https://hypothesis.readthedocs.io/en/latest/reference/strategies.html), Collections `lists()` shrinking. Better job: shows how shrinking can switch to a different bug. Taken: §5.1 stable dependency structure; §5.4 frozen target and preconditions. Not copied: its random generation engine or a Python dependency.
7. **R7 — Honest delta debugging.** [Zeller, Reducing Failure-Inducing Inputs](https://www.debuggingbook.org/html/DeltaDebugger.html), `ddmin`, PASS/FAIL/UNRESOLVED, reproducibility, tree reduction and HDD background. Better job: separates unresolved cases and 1-minimality. Taken: §5.4 chunk deletion, explicit unresolved outcomes and smallest-found claim. Not copied: global minimum or unconditional determinism. Original paper PDF was not readable; the opened author chapter is the source used.
8. **R8 — Interestingness contract.** [Regehr, Design and Evolution of C-Reduce, part 1](https://blog.regehr.org/archives/1678), interestingness tests, pass ordering and timeouts. Better job: explains loopholes and why structural deletion comes first. Taken: §5.4 cheap validity checks before replay, frozen interestingness, broad deletion before optional numeric changes. Not copied: many compiler-specific passes or an unbounded search.
9. **R9 — Saved input as CI regression.** [LLVM libFuzzer docs](https://llvm.org/docs/LibFuzzer.html), Options (`minimize_crash`, run/time budgets) and file-input replay. Better job: reduction/replay is separate from new generation. Taken: §5.4 explicit budgets and stop reason; §5.5 file-only replay without UI. Not copied: coverage engine, random mutation or timeout-as-node-bug semantics.
10. **R10 — Versioned Ethereum fixtures and closer prior art.** [EELS/EEST release](https://github.com/ethereum/execution-specs/releases/tag/tests-bogota-devnet%40v2.0.0), [blockchain format](https://github.com/ethereum/execution-specs/blob/ca8c60947b8b1541d9278bdc9a4d100287f033f9/docs/running_tests/test_formats/blockchain_test.md), consume docs, `tests/bogota/eip8141_frame_transactions/test_admission_validity.py` and `eip8250_keyed_nonces/test_keyed_blob_transactions.py` at that pin. Opened old docs migration notice and new STEEL home too. Better job: pre/blocks/post, fork schedule, reference-spec versions, fill versus consume. Taken: §5.1 frozen pre-state and independent expectations; §2 admits existing sequences and live-RPC frame tests; §4 forbids mixing protocol revisions. Not copied: full EEST integration, newer Bogota wire format, or its public test-key fields as secret material.
11. **R11 — Harness/client boundary.** [Hive overview](https://github.com/ethereum/hive/blob/master/docs/overview.md), How it works and Simulation Output Files; README license. Better job: separate simulator logic from client configuration and retain logs with results. Taken: §5 adapter capabilities, explicit genesis/config and per-case evidence. Not copied: multi-client matrix, generic orchestration or GPL implementation code. Branch docs are inspiration only; not a runtime dependency pin.
12. **R12 — Explain a failure in context.** [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer), Actions, Before/After, Errors, Network, Metadata and local trace opening. Better job: ties a selected step to evidence and source. Taken: §6–7 linked first mismatch, before/after state and raw call; §5.5 portable local bundle. Not copied: DOM snapshots, filmstrip, automatic first-retry-only capture or browser-test infrastructure.
13. **R13 — Replay claim boundary.** [rr](https://rr-project.org/), what it does, debugging experience and limitations. Better job: distinguishes replaying captured execution from running again. Taken: §1 and §5.3 call our two runs a consistency check; offline log viewing is distinct from fresh replay. Not copied: instruction-level determinism, reverse execution or rr integration.
14. **R14 — Reviewable stable evidence.** [Insta advanced features](https://insta.rs/docs/advanced/), Redactions, Custom Descriptions/Infos and Snapshot Updating. Better job: stable comparisons with review metadata; CI does not silently update snapshots. Taken: §5.5 explicit normalization and manifest; §11 no auto-approval of changed oracle outcomes. Not copied: `force pass`, automatic “always” approval, a Rust dependency, or redacting fields that decide a verdict.
15. **R15 — Seed is not the whole replay.** [Foundry testing](https://getfoundry.sh/forge/fuzz-testing), Fuzz testing, Traces and table-row skipping sections. Better job: names reproduction dependencies beyond a seed and exposes failure context. Taken: §5.3 pins/config/reset in comparison; §11 zero/reached assertion tests; raw failing-frame context in timeline. Not copied: a claim about fuzz shrinking (not verified on the opened page), Solidity-only runner, symbolic execution or cheatcode state mutation as a real chain trigger.

## 17. Inspection limits and rejected directions

1. Sidecar tree was inventoried at 2e22ff0 and default master; bodies named in R3 were inspected. Balance-drop coverage is a unit test with an injected balance callback, not demonstrated e2e payer-drain coverage. Cancellation e2e uses an explicit debug reputation shortcut. Shared-sender e2e is already a sequence. No claim that “sequence tests do not exist.”
2. bundler tree was inventoried at 17bd608d. Named R5 bodies and searches for invalidation/revalidation/replacement/pending-state checks were inspected. They contain stateful cross-sender/bundle assertions. The reputation-threshold test in `test_reputation.py` is marked skipped; source presence is not executed coverage. No reusable version-labelled pending-lifecycle reducer was found there. Unread tests may contain more; filename/grep inspection cannot prove absence.
3. EELS tree at ca8c609 was inventoried for 8141/8250; R10 names the test bodies read. It is closer prior art than the old spec admitted. The audit did not inspect every test or prove lack of ERC-8421 support.
4. Web/GitHub search covered ERC-8421 invalidation tooling, EIP-8141 sequence tests, and RIP-7560 invalidation testing. It found EELS frame tests and existing AA suites, but no verified drop-in replacement for this exact workflow. This is not an exhaustive search or a uniqueness claim.
5. Inspected but not adopted: full Hive orchestration and Kurtosis expansion (hours and scope); rr runtime integration (wrong guarantee and setup); Foundry shrinking claims (not verified); libFuzzer generation (random fuzzer is CUT); Insta auto-pass/auto-update (would hide failures). Keep only the specific lessons in §16.
6. Unusable links were not treated as evidence: guessed Hypothesis shrink page, LLVM Bugpoint page and old EEST consume path returned 404; Zeller's original PDF did not load. Verified alternatives are named in R6–R10. Tenderly, AFL++, ApprovalTests and consensus-spec-tests were not opened or used; no claims are made from them.
7. Original proposal history: this audit read the full local spec and `whole_history_conclusion.md`, not the original transcript around message 437. It does not invent or quote that message. Current full Notion spec was read before editing. Bet-page history is left unchanged.

## 18. v2 build plan (clock times IST)

### 18.1 Repo layout

`framelab/` is its own git repo. Upstream clones live in `../vendor/{sidecar,ethrex}` and are never committed.

```
framelab/
  LICENSE, NOTICE                 # FrameLab license + Etherspot MIT notice for extracted helpers
  package.json, tsconfig.json     # Bun + TypeScript; deps: viem, yaml, ajv
  src/
    cli.ts                        # framelab env|run|shrink|replay|compare; exit 0/1/2 (§5.5)
    env/ethrex.ts                 # pinned container lifecycle, JWT, genesis, reset (D1, D7)
    env/stepper.ts                # engine-API payload stepper (D1, D3)
    env/sidecar.ts                # build pin + patches, spawn, config, dataDir (D4, D5)
    adapter/sidecar.ts            # RPCs, explorer drain, bootId/seq checks, capabilities (§5.2)
    scenario/{schema,load}.ts     # framelab.scenario/v1 (§5.1)
    runner/{run,checkpoint,projection}.ts   # steps, waits, evidence, double-run compare (§5.3)
    oracle/{rulepack,verdict}.ts  # pure: events + expectations → verdicts (§4)
    reducer/ddmin.ts              # dependency-aware deletion (§5.4)
    bundle/{export,replay,scan}.ts          # allowlist, secret scan, replay.sh (§5.5)
    vendor/sidecar/               # extracted MIT helpers only (D6)
  rulepacks/sidecar-policy@2e22ff0.json
  scenarios/{s1-payer-drop,s1-noisy,s2-storage-dep}.yaml
  patches/{sidecar-observe,inject-s1-oldest-first}.patch
  viewer/index.html               # static timeline over a local bundle (§7)
  test/                           # bun test: oracle, reducer, projection, negative paths
```

### 18.2 Schedule

| Block | IST | Work | Exit criterion |
|---|---|---|---|
| B0 | 08:45–09:15 | Start Docker; pull pinned devnet image; `bun install && bun run build` of sidecar at pin; repo skeleton | Image digest matches V9; sidecar `./skandha standalone --help` runs |
| B1 | 09:15–12:15 | Gate G1–G6 (§9), in order G1 → G2 → G3 → G4 → G5 → G6 | See 18.3 |
| — | 12:15–12:45 | Break | |
| B2 | 12:45–15:15 | Harden adapter, reset, fixtures, runner; measured limits written into scenarios | Two fresh S1 runs agree on the semantic projection |
| B3 | 15:15–17:45 | Oracle, rule pack, S1 + S2, negative paths for acceptance test 3 | Acceptance tests 1–3 and 9 pass |
| — | 17:45–18:15 | Break | |
| B4 | 18:15–20:15 | Reducer, predicate checks, cache, budget, stop reason | Acceptance test 4 passes |
| — | 20:15–20:45 | Dinner | |
| B5 | 20:45–22:15 | Bundle, `replay.sh`, secret scan, `compare` | Acceptance tests 5–7 pass |
| B6 | 22:15–23:45 | Viewer over real bundles | Acceptance test 8 passes for built states |
| — | 23:45–00:15 | Freeze: full §11 run; tag `v0.1-rc` | Recorded results, not edited |
| — | 00:15–06:15 | Sleep | |
| — | 06:15–07:00 | Buffer: fix acceptance failures only; no new features | |
| — | 07:00–09:00 | Demo recording from the actual final run (§12) + submission | Submitted before 09:00 |

### 18.3 Gate timeboxes and kill criteria

1. G1 by 09:45: container up, `eth_chainId = 0x9`, startup and simulation latency recorded. If emulation makes one simulation slower than about 5 s, stop and tell Shubham before continuing.
2. G2 + D1 by 10:30: the stepper produces a VALID Hegota block; one frame tx is admitted, then relayed with `sendBundleNow`, stepped and included, with a receipt and an explorer record. If the stepper misses its 45-minute box, switch G2 to D2 and record that reduction is at risk.
3. G3 by 11:00: two whole-stack resets with a normal trigger tx give the same block numbers and timestamps. Reset wall time is recorded.
4. G4 by 11:30: the observation line appears once per stepped block; a forced sidecar restart is detected through `bootId`.
5. G5 by 11:50: S1 with one reached assertion gives PASS or EXPECTED_INVALIDATION; a removed checkpoint gives exit 2.
6. G6 by 12:15: injected regression plus ten noise steps shrink to a smaller confirmed case.
7. Hard decision at 11:30: if G3 or G4 has failed, switch to the OFFLINE ANALYZER (§9) and recompute §10 before doing anything else. If only G5–G6 slip, they may run until 12:45. That time comes out of B6 first (cut order, §10).

### 18.4 Change log

- v2 (2026-11-06 08:45 IST): added §0 verified facts V1–V11 and decisions D1–D7; set the driver (engine stepper) and completion signal (observation patch); recomputed the budget to 13 build hours; added the S1 fixture choice; added §18. No change to product scope, verdict classes or the cut list.
- v2.1 (2026-11-06 09:35 IST): added V12–V14. G1 now runs a local arm64 build of the pinned ethrex commit, because the published amd64 image does not start under Rosetta. S1 became keyed self-pay. Recorded the G6 mutation patch and its expected four-step floor. Order change: B3 oracle, B4 reducer and G6's fixture and patch were written and unit-tested (21 tests, fake node only) while the ethrex image compiled. Their live-node runs still wait on G1–G4. Gate clock: G1 slips to about 10:00 because of the image build. The 11:30 hard decision is unchanged.
- v2.2 (2026-11-06 10:10 IST): added V15–V17 (measured) and D8–D10. All six gates passed by 09:55 IST, and acceptance tests 1–4 passed live by 10:05 (results in §18.5). S2 is a contract account whose VERIFY reads its own slot 0. The OFFLINE ANALYZER fallback is not needed. The remaining order is unchanged: acceptance 5–7 (bundle, replay, compare), then the B6 viewer, then the freeze. Time saved goes to buffer, not to new features.
- v2.3 (2026-11-06 11:00 IST): B6 built and acceptance 8–9 passed live (§18.5). Fixes found while driving the UI, all committed: (a) `replay.sh` wrote its output, including the run's engine JWT and logs, inside the bundle folder; those files were outside `SHA256SUMS` but would travel with a shared folder. Output now goes to `$FRAMELAB/.runs`, `check-pins` warns about unlisted files in a bundle folder, and `manifest.json` is now covered by `SHA256SUMS`; all bundles were re-exported at `98ac664`. (b) Acceptance 9 had no implementation: a compatibility check now runs before any build or node start. (c) UI: polling no longer rebuilds controls under the pointer, so clicks are not lost. No product-scope change; Spec divergence stays unbuilt.
- v2.4 (2026-11-06 11:30 IST): froze early. Added `scripts/acceptance.sh`, which reruns §11 and writes its own results, and tagged `v0.1-rc` at `d2d3bec` after 54/54 (§18.5). This is about 12 hours ahead of the 23:45 freeze slot. Until 09:00, the remaining work is the README and submission text, and the §12 demo recorded from a real run of the tagged build. Any code change after the tag reruns the suite before it is used in the demo. No new features.
- v2.5 (2026-11-06 12:40 IST): the owner widened the release scope in two ways. (a) He authorized one use of the public devnet: one funding transfer from the published genesis key to a new throwaway key, then one frame tx. `framelab devnet` does this with an RPC method allowlist (no `debug_bundler_*`, no privileged submit), a preflight on chain ID, ethrex pin and head age, a key kept outside the checkout, and a refusal to send again without `--again`. The same path runs on the local stack in CI (`src/gates/devnet-local.ts`). The local sidecar gained an optional `bundlingMode`; it stays `manual` for every release check. (b) He approved a public repo, `batmnnn/batcorp`, with FrameLab under `framelab/` and its history kept with the original SHAs. `vendor/` is no longer committed; `scripts/setup-vendor.sh` fetches the pinned commits. CI runs `scripts/acceptance.sh` on linux/amd64 with the published ethrex image. The spec moved to `docs/framelab-spec.md` unchanged, and the `v0.1-rc` evidence bundles are committed under `framelab/evidence/`. Results are in §18.6. The release checks themselves are unchanged and still run only on the isolated local chain.

### 18.5 Measured results (live, pinned local stack)

| Check | Result | Evidence |
|---|---|---|
| G1 | arm64 ethrex `9aa3645d` up, chain ID 9, genesis sha256 `5fe93acb…1fb4` | `.runs/g1-*` |
| G2 + G4 | Frame tx admitted, relayed, stepped, included with receipt and explorer record; one observe line per block; forced restart changes `bootId` | `.runs/g2-*` |
| G3 | Two whole-stack resets give identical block numbers, timestamps and hashes | `.runs/g3-*` |
| G5 / acceptance 1 | S1: PASS, exit 0, 5/5 assertions on both runs, projections agree | `run-s1-payer-drop-*` |
| S2 | PASS, exit 0, 2/2 on both runs; slot 0 reads 1 at admission and 0 at the trigger; the gated tx is in the pass's revalidated set and cancelled ("validation frame 0: reverted") | `run-s2-storage-dep-*` |
| Acceptance 2 | Flipped S1-A2: FAIL, exit 1, only S1-A2, `ASSERTION_MISMATCH`, "wrong test expectation" | `run-s1-neg-wrong-expectation-*` |
| Acceptance 3 | Exit 2 for each of: zero assertions (0/4 executed), skipped checkpoint, transport failure (sidecar killed), pass timeout, sidecar restart (`bootId` changed), inconsistent double runs (run 2 on the injected build) | `run-s1-neg-*`, `negative-s1-payer-drop-*` |
| G6 / acceptance 4 | Injected oldest-first build: S1-A1 WRONGLY_EVICTED on both original runs; 18 steps shrink to 7 (2 setup, 4 action, 1 checkpoint); 29 invalid candidates rejected before any node run; final two fresh runs reproduce; not shown to be 1-minimal (V14). Re-run on the D8 code: same path, 122 s, S1-A3 pruned, reduced case re-judges FAIL | `shrink-s1-noisy-inject-s1-*` |
| Acceptance 5 | `replay.sh` from the exported G6 bundle (clean commit `621df46`): checksums and pins pass, the reduced case is FAIL on both runs (2/2 executed), exit 1 as recorded. Four tampered copies (edited scenario, deleted `node_pin.json`, changed sidecar pin, changed fixture patch) each exit 2 with a named error before any node starts | `bundles/g6-s1-noisy-inject`, `.runs/tamper` |
| Acceptance 6 | Export of a run with a planted fake GitHub token and a planted secret env value: both found, export refused, no bundle left. The two real bundles contain no per-run engine JWT and no PEM or token pattern | `.runs/secret-plant` |
| Acceptance 7 | The injected bundle's reduced case on the unpatched build: PASS, exit 0, consistent runs. `compare` reports S1-A1 WRONGLY_EVICTED → PASS, same scenario and rule hash, separate old and new build hashes, expectations unchanged. A mismatched pair is refused with exit 2 | `.runs/fix-check/compare.json` |
| Acceptance 8 | `framelab serve` (127.0.0.1 only; foreign Host header → 403, POST without the FrameLab header → 403, paths outside `bundles/` and `.runs/` refused). Every built state reached from real work in the browser: Empty; Start network → Ready with real pins, 5/5 verified quotes and capabilities; Run s1-noisy on the injected build → Running from `progress.jsonl` (run k/2, step, checkpoint wait) → Fail (S1-A1 first mismatch, injected banner); Shrink → Shrinking from real candidate progress, including the candidate on the node now → reduced result (18 → 7 steps, S1-A3 pruned, honest minimality claim); Export from the UI → clean bundle, `check-pins` passes (first at `5e8767b`, re-exported at `98ac664` after the replay fix); Pass from `bundles/s1-baseline`; Inconclusive from the zero-assertions run (causes listed once, run-level first); Cancel during S2 run 2 → INCONCLUSIVE, exit 2, export refused. Spec divergence is shown as "(not built)". Saved bundles also open without the server (folder mode; checked by loading the G6 bundle's files in that mode — the OS folder picker itself needs a person) | `.runs/ui-*`, `bundles/ui-shrink-*` |
| Acceptance 9 | `s1-current-codec` (S1 declaring the current EIP-8141 draft codec): INCONCLUSIVE, exit 2, in 0.2 s, with the compatibility reason; no build, no node, no assertion judged; export refused; same result through the UI. Unit tests cover a pack from another sidecar revision or codec, a missing pack, an extra protocol requirement and a policy mismatch. Allowed-policy removals stay green: S1-A3/S1-A4 (SP-BAL-ENFORCE) and S2-A1 (SP-REVALIDATE-NEW) are EXPECTED_INVALIDATION in passing runs | `.runs/run-s1-neg-current-codec-*`, `test/compat.test.ts` |
| Freeze, `v0.1-rc` | `scripts/acceptance.sh` on clean `d2d3bec`, 05:51–05:57 UTC: 54 of 54 checks met. It reruns acceptance 1–7 and 9 live, each judged by its exit code plus a content check of the files written: S1 and S2 PASS; flipped S1-A2 fails there only; all six causes of doubt are INCONCLUSIVE; shrink 18 → 7 with the final two fresh runs reproducing (13 of the candidates answered from the persistent cache, which is keyed on build, rules and pins); replay exit 1; five tampered bundles stopped before any node starts; planted secrets refused; fix comparison passes; current-codec not applicable. For acceptance 8 the suite checks only the server guards; the UI states are the B6 record above. A first run on `6948b81` also met all 53 checks it had, but it hung after the guard checks until its test server was stopped by hand (fixed in `d2d3bec`) | `.runs/freeze-d2d3bec/summary.tsv` |
| Acceptance 5 (re-run) | After the replay fix below: G6 bundle re-exported at clean `98ac664`; `replay.sh` exit 1 as recorded, output under `.runs/replay-g6-*`, bundle folder unchanged (22 files); a copy with an edited `manifest.json` exits 2 at the checksum step before any node starts | `.runs/replay-g6-s1-noisy-inject-*` |

### 18.6 Public devnet and publication (owner-authorized, v2.5)

| Check | Result | Evidence |
|---|---|---|
| Local devnet path | `bun src/gates/devnet-local.ts`: dry run sends nothing; the real path funds a throwaway key, submits one frame tx to an auto-bundling local sidecar, and sees it `OnChain` in block 3 | `.runs/devnet-local-*` |
| Public devnet tx | Preflight: chain 1337, ethrex `9aa3645d` (x86_64), sidecar v4.1.1 in auto bundling, head 371, 2 s old. The devnet had stalled at block 408262 and was reset before this run. Funding: 0.01 ETH from the published genesis key `0x5544…16f9` to the throwaway `0xD39e…1509`, block 372, 204,600 gas. Frame tx [`0xd0585cf5…0814`](https://explorer.altmempool.wtf/tx/0xd0585cf5ee9e6a599d206c6f2acdcafc62e5e73e6c65cc67acaf4877c0eb0814?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) (self-verifying payer frame plus a 1-wei self call, nonce key 0): simulation canonical-mempool valid; admitted by the public sidecar; New 07:06:10, Submitted 07:06:17, OnChain 07:06:49 UTC in block 378. A separate `eth_getTransactionReceipt` gives type `0x6`, status `0x1`, 26,102 gas. The explorer shows it On chain, "Submitted to this node by RPC", with every admission rule passed. Both signing keys were scanned for in the record before it was written; the throwaway key is not in the repo | `framelab/evidence/devnet-2026-11-06/` |
| Publication | Public repo https://github.com/batmnnn/batcorp, tag `v0.1-rc` on `d2d3bec`. Before the first push, the full history was scanned: the only private keys are the published ethrex fixture keys, with no home paths and a noreply author | git history |
| CI, linux/amd64 | GitHub Actions on ubuntu-24.04 with the published ethrex image (`ghcr.io/forshtat/eip8141-devnet@sha256:c9a7…24c6`). Run [42181113803](https://github.com/batmnnn/batcorp/actions/runs/42181113803) on clean `bc33516`: 54 of 54 met in 11 min 20 s, then the devnet submit path on the local stack passed. The CI shrink gives the same numbers as an uncached local arm64 run: 18 → 7 steps, 20 candidates node-tested, 29 invalid, 11 unresolved, 336 s. The first run ([42178535641](https://github.com/batmnnn/batcorp/actions/runs/42178535641), `de511ed`) met 46 of 54, for two reasons. First, the codec cross-check test crashed on a checkout with no sidecar build; fixed in `bc33516`. Second, the first live shrink candidate timed out waiting 15 s for the sidecar's first reconcile pass (block 0), so the shrink stopped with exit 2, and a5's scenario-tamper check and a7 had no reduced case. That timeout did not recur and its cause is **not known**. It failed safe (exit 2, never a verdict), and CI now uploads per-run node logs whenever a check fails | Actions runs |
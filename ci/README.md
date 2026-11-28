# CI gate map

`ci/ci.sh` runs the gate map `ci/gates.json` (written once by P1-GATES; BUILD_PLAN section 7, D-15).
`pnpm run ci` calls it. It writes `.build/ci/ci-verdict.json` with `totalDurationS` and per-gate `durationS`. It also writes the flat verdict the dashboard reads: `.build/ci-verdict.json` on a full run (`--all`), `.build/ci-only-verdict.json` on a merge-set or `--records` run, so a quick run never overwrites the full verdict. Both are git-ignored.

| Command | Runs |
|---|---|
| `ci/ci.sh` | the merge set: gates tagged `when: merge` |
| `ci/ci.sh --all` | the push set (not the wave gate; the wave gate is the GitHub push run, which is the merge set): every active gate except the `when: nightly` ones, `onlyWhenChanged` gates scoped, then `ci-time-check.py` (row `scope: push`) |
| `ci/ci.sh --checkpoint` | the checkpoint set (owner answer 24ad46b5, F-1410): the nightly set plus the `when: checkpoint` gates (look-values-comparator-nightly), recorded as a nightly run |
| `ci/ci.sh --nightly` | the nightly set: every active gate unscoped, the `when: nightly` gates included (not the `when: checkpoint` ones), then `ci-time-check.py` (row `scope: nightly`) |
| `ci/ci.sh --gates <ids>` | only the named gates (a comma list, repeated words or `--gates=a,b`), unscoped, nightly gates too; an id not in the map stops the run at start-up (exit 2); in the wave container a named `runner: mac` gate is skipped there (`MAC <id>: runner mac, not run here`) and runs in the mac half only (F-1432) |
| `ci/ci.sh --records` | only gates that declare `reads:` globs (commits that touch only records) |
| `ci/ci.sh <set> --list` | prints the gates the set would run and the sum of their `timeoutS`; runs nothing |

Owner rulings Nov 2 ("Daily + phase close", P3-CI-CADENCE) and Nov 4, 2026 (CI cadence amendment): the wave gate is the green GitHub push run on the merged head, which is the merge set (`ci/ci.sh`); "push set" means only `ci/ci.sh --all`. The nightly set (`ci/ci.sh --nightly` by way of `ci/wave-run.sh`, `BW_CI_ARGS=--nightly`) is the only run of the other 18 gates; it runs at most 2 hours, at least once in every 24 hours, on Spectre, and appends its row (scope nightly, `BW_CI_CHANGE=<label>` when it tests a fix) to `.build/ci-time.jsonl`. After a red push or nightly run, run the merge set plus the red gates (`--gates`) on the fix head. The 3 `when: nightly` gates are the halves the push set leaves out: `G-CI4-nightly` (every merge-set test under 3 zones), `page-walkers-nightly` (WebKit, the all-screens Spanish and overflow passes, the import stack suite `ci/import-stack.sh`) and `look-values-comparator-nightly` (WebKit). A stopped run (SIGINT, SIGTERM) prints what each running gate had printed so far; with gates side by side every gate's output also lands in `.build/ci/gate-logs/<id>.log` as it arrives. A gate that times out and may share the engine keeps its slot until the Compose projects started since the run began are gone (at most `CI_SETTLE_CAP_S` seconds, default 90).

A gate entry with no valid `when` (merge, wave, signoff, nightly, checkpoint) stops the run at start-up (exit 2).
Every selected gate runs to the end; a red gate never stops the run.

## Activation (D-15)

A gate is active when its marker `ci/active/<gate ID>` exists.
An inactive gate prints `INACTIVE <id>: activates when <task> merges` and is recorded as `inactive`.
The one lane named in `activates` adds the marker in the commit where the gate first runs green.

## What an active gate runs, and its time limit

Every gate in `ci/gates.json` resolves to a command with no later edit to the file:

- A gate with a `cmd` runs it (the 9 gates P1-GATES and P1-REPO own).
- A gate with `cmd: null` runs the script `ci/gates/<gate ID>.sh` (`bash ci/gates/<gate ID>.sh`), from the repo root.
  The activating lane adds that script and the marker `ci/active/<gate ID>` in the same commit, when the gate first runs green.
- A second lane that builds part of a gate adds its case files under `ci/gates/<gate ID>/` (for example `ci/gates/G-CI4/<case>`) and never activates the gate. The activating lane's script runs them.
- An inactive gate (no marker) stays inactive, prints its activating task, and never runs, whether or not its script exists.
- An active gate with `cmd: null` and no script fails with `ci/gates/<id>.sh is missing`, naming the file the activating lane must add.
- The script's exit code decides the gate: 0 is pass, anything else is red.

Time limit: `defaultTimeoutS` in `ci/gates.json` (300 seconds) applies to every gate; a gate's own `timeoutS` overrides it
(`page-walkers` sets 720 s, F-290; `import-target-counts` sets 600 s, F-314: about 2.1 times its slowest measured green
on Spectre, 282.3 s, with the run sha in the file's `_doc`; `restore-test` sets 700 s, F-400 and F-485: about 2.5 times its
slowest measured green on Spectre, 278.3 s at dcb5ca7, replacing the 360 s set from a Mac rig; D-15 as plan v0.11 amends it lets a gate's builder lane set a
measured `timeoutS` only). The 300 s comes from a measured green `ci.sh --all` run (2026-10-31): slowest gate `unit-tests` 4.1 s,
whole run 7.7 s. That is about 70 times the slowest gate and at least 2.5 times the expected time of each planned Playwright
gate (`look-values-comparator`, `page-walkers`, each expected under 120 s). Measured in wave 4 on Spectre (docker context spectre, wave run for sha bbbbf0b, `.build/evidence/30-W4-closing-pass/wave-run-bbbbf0b.log`) with both Playwright gates active (F-30): `page-walkers` 35.24 s, `look-values-comparator` 47.58 s, the full `ci.sh --all` run 102.9 s, all against the 300 s per-gate cap (`look-values-comparator` is 16 percent of it and `page-walkers` 12 percent, both far under half). Both gates grow
with each phase's screens (81 inventory rows by phase 6); re-measure at the first wave whose current phase is 4, and raise
`defaultTimeoutS` below the job limit if a gate passes half the cap. It is strictly below the 900 s `checks` job limit,
which also pays for install, so the per-gate cap fires before the job timeout. Keep any gate's `timeoutS` below its job limit. A gate over its limit is killed with its whole process group, recorded red with
`reason: "timeout: exceeded <n>s and was killed"` in `ci-verdict.json`, and the run goes on to the next gate.

## Gates side by side (F-410)

A gate with a `parallel` field runs beside other such gates; a gate without one runs alone (nothing else running), so a
new or newly activated gate never joins the pool by accident. `"parallel": { "exclusive": [] }` states that the gate's
script shares nothing mutable with any other gate: no fixed port, database server or name, docker container, network,
volume, image tag or Compose project name, fixed /tmp or work path, browser profile, lock file, or log or verdict file.
A gate that does share one names the group in `exclusive`; `exclusiveGroups` at the top of `ci/gates.json` declares each
group and the resource it guards, and 2 gates in one group never run at the same time. Today there are 2 groups.
`engine-net`: every gate that starts or removes a container (a Compose stack or a single `docker run`) or drives a
browser (F-290, net::ERR_NETWORK_CHANGED). Check every file the gate runs, not only its script: the configs it names
and the test files they include (F-464: map-manifest's nginx test). The declaration test in `ci/run-gates.test.ts`
follows those files and fails on a gate that touches the engine but is declared outside the group.

`heavy` (F-485): the wave rig itself, 1 WSL2 VM with 8 vCPUs, 15.5 GiB and 1 virtual disk. Two long gates side by side
slow each other far more than a fair CPU share would. At d822332 page-walkers' preview image build ran 335 s beside
G-CI7's PostgreSQL step (32 to 88 s in 24 other wave runs), and G-CI7 ran 288 s instead of 111 s; both hit their limits.
Members: every `engine-net` gate, plus G-CI4, G-CI7 and G-CI2 (the embedded-PostgreSQL gates over 100 s alone on the rig;
G-CI2 144.35 s at b405206c, F-1164).
A new gate joins when it builds an image, brings up a stack, drives a browser or runs over 100 s alone on the rig.
`page-walkers` (515.7 s alone, 72 percent of its limit) has no `parallel` field, so it runs alone. The other
declared gates still run beside a heavy one. The wave run also builds the `BW_WEB_PREVIEW=1` web image during setup,
so the shell stack's own build is a cache hit (`ci/wave-run.sh`; `ci/wave-run.test.ts` checks each build-argument set).

At most `--jobs=<n>` gates run at once (or `CI_MAX_PARALLEL=<n>`); the default is 2 on the 8-CPU, 16.6 GB wave rig,
lower on a smaller host (1 per 2 CPUs and per 4 GiB). Why 2: the engine-net gates run 1 at a time and their chain
(about 900 s at cd7aa37, 1180 s when restore-test runs) is longer than every other gate in 1 lane beside it (about
750 s), so a 3rd slot buys no wall time; it only adds CPU contention against fixed timeouts (G-CI4: 216 s of 300 s
alone) and memory (2 browsers or a 5-service stack, estimated 4 to 5 GB, plus 1 vitest gate, estimated 2 GB, of 16.6 GB). `--serial` (or a cap of 1)
is the old runner: map order, output streamed. Above 1, slots go to the longest gate in `.build/ci-time.jsonl` first,
each gate's output prints as 1 block when it ends, `ci-verdict.json` keeps map order, `totalDurationS` is the wall time
and `gateDurationSumS` the sum of the gates' own times. A gate's process group is killed when the gate ends, on its
timeout, and (every running gate's) on SIGINT or SIGTERM to the runner.

## How "the activating task has merged" is decided

A task has merged when a merge commit reachable from the integration branch carries a `Task: <ID>`
trailer line in its message (`git log --merges --format=%B <ref>`). The ref is `GATE_MAIN_REF`, else
`origin/main`, else `main`; with none of them, `gate-activation-check` exits 2 (never a pass).
In CI the checkout must therefore fetch full history (`fetch-depth: 0`).
The build manager puts `Task: <ID>` in every lane's merge commit message.

`node ci/gate-activation-check.ts` fails when a merged activating task has no marker
and when a marker names no gate.

## Other files

- `ci/secret-scan/README.md` (P7-SCANS): the privacy scan (`G-CI6`) and the publish-set secret scan (`privacy-secret-scan`, gitleaks 8.30.1 pinned in `ci/gitleaks/pin.json`, installed by `ci/gitleaks/install.ts`), the F-341 allowances, and the re-scan command P8-PUBLISH runs.
- `ci/page-inventory.ts` generates and checks `acceptance/page-inventory.json` against `docs/UI-SPECIFICATION.md` section 2.3.
- `ci/typecheck-coverage.ts` fails when a tracked TypeScript file outside `apps/` and `packages/` is in no typecheck (root `tsconfig.json`).
- `ci/test-reason.sh` runs the vendored `test-reason-check.py --since <merge base>`; see `ci/vendor/jl-dev/VERSION.md`. F-1571: `ci/vendor/` is the owner's private copy of 2 jl-dev scripts and the public export leaves it out (scripts/private-paths.txt), so in the public tree this script and the ci-time-check calls in `ci/run-gates.ts` and `ci/wave-run.sh` print that they were skipped. `node ci/public-files.ts private-refs` fails when any other exported file names `ci/vendor/`.
- `ci/test-reason-orphans.sh` (private: left out of the public export, F-1571) runs the same tool with `--orphans` and also admits the gate IDs that docs/BUILD_PLAN.md defines with a `G-` heading (F-1174). It passes only those IDs, never the whole plan, so a plan task ID is still an orphan. The bare `--orphans` command does not know gate IDs.

## What runs on push, and what runs per wave (F-26, F-37)

CI is local only (owner rulings 7b7a6a90, f3b1a4af): no GitHub-hosted runner, no workflow_dispatch, no GitHub-triggered job.

- **Push** (`.github/workflows/ci.yml`, job `checks`): the merge set only, `pnpm run ci`, on the 2 self-hosted runners. The push run is held to 10 minutes. It runs on pushes to `main` only (F-405: agent branches run their own checks, and each wave gets one full run on the Spectre runner), and skips a push whose changed files are all record paths (`.build/**`, `docs/BUILD_REPORTS/**` and the others listed in the workflow's `paths-ignore`). Its `node` container reaches the linux runner's own engine (F-536): the engine's socket, its docker CLI and Compose plugin, and the engine's path of the work directory are mounted in, and `pnpm run ci` runs from that path, so a Compose stack a gate starts resolves its bind mounts on the engine. Kept by plan (P4-LESSONS-REMOVE keeps the F-536 access); no merge-tier gate starts a stack today (push-set unit tests use a fake docker, ci/engine-self-check.test.ts), so this is for a gate that may.
- **Per wave** (`bash ci/wave-run.sh [<sha>]`, started by hand by the build manager on this Mac): `ci.sh --all` on the merged head, default HEAD. It also copies the container's flat `.build/ci-verdict.json` to the Mac's `.build/ci-verdict.json` (what the dashboard reads), atomically and only when its sha equals the wave sha; otherwise it prints a WARN and the wave result is unchanged.
  - It clones a clean export of exactly that sha and pipes it into a container on Spectre (`docker --context spectre`; bind mounts would resolve on Spectre's disk).
  - Inside the digest-pinned `node:26.12.1-bookworm-slim` image it runs `pnpm install --frozen-lockfile`, installs Chromium and WebKit, then `ci.sh --all`. `BW_PW_ENGINES` stays unset.
  - The container name is unique per run and no host port is published (the Spectre push runner shares that machine).
  - It copies `ci-verdict.json` out and checks its `sha` and `result`. A missing verdict, a sha mismatch or a failed result is red (exit 1).
  - Spectre unreachable exits 10 (WAIT): not green, not a red verdict. Run it again when Spectre is up.
  - The whole-run cap (`bash ci/wave-run.sh --print-cap`) is above install time plus the 2 h full-CI budget plus the largest per-gate limit in `gates.json` (F-28 class). When it fires, the script removes the container, not only the client. `ci/wave-job-timeout.test.ts` enforces the margin.
  - The mac half (F-1201) runs the gates whose `runner` is `mac` in `gates.json` (`ci/mac-half.ts`, by the same `when` rule as `ci.sh`): `native-no-demo`, and in the nightly `native-suite` (`apps/tech-native/xcuitest/suite.sh`, about 36 minutes). They run on this Mac's checkout, which must be at the run's sha with no tracked change outside `.build/`; a red or timed-out mac gate makes the run red. Since the owner ruling of Nov 10, 2026 (item 3) the mac half starts when the run starts, beside the Spectre half, and the verdict still needs both; hold commits on main only from the output line `MAC HALF STARTED` to the line `MAC HALF ENDED`, and each mac gate's measured time is in the line `mac half measured`. `ci.sh` never selects a `runner: mac` gate in its sets (only `--gates` by name, and in the wave container that run skips it: the narrow verdict takes its row from the mac half, F-1430), so the merge set and the GitHub push run are unchanged. `bash ci/wave-run.sh --mac-half [<sha>]` (with `BW_CI_ARGS=--nightly` for the nightly set) runs the mac half alone and starts nothing on Spectre. Browser gates do not run on the Mac (Playwright is barred from the host, and there is no WebKit build). The xcode check stays on push on the mac runner.
  - It ends with `ci-time-check.py` output. The wave run must be green before the next wave (BUILD_PLAN section 7, Full CI row).
- `ci/wave-run.test.ts` proves the verdict judgment (missing verdict, sha mismatch, failed result are red) with no docker and no browser.

## Browser runtime for CI (any Playwright gate)

Browsers are installed inside the wave container, never on a developer machine: `bash ci/install-browsers.sh [chromium] [webkit]`
runs `playwright install --with-deps` at the repo's pinned Playwright version (1.64.1). It refuses to run unless `BW_WAVE_CONTAINER=1`
(set by `ci/wave-run.sh`) and `/.dockerenv` exists, so it cannot run on the Mac host.

## page-walkers (`ci/gates/page-walkers.sh`)

Walkers live in `ci/page-walkers/`: `axe-scan` (color-contrast off, OA-84), `tap-target-44`, `outside-origin-guard`
(`guardedContext`, the fixture every Playwright test opens its context with), `spanish-fallback-pass`, `overflow-pass`.
The gate prints the inventory selection, then runs the proofs on Chromium and WebKit: each walker must flag its planted
known-bad page and pass its clean page. The selection is every inventory row at or before the current phase, of any type: pages
are walked, dialogs, sheets, popovers and panels are opened on their host page, native-only screens are listed as handed to the
native audit. Per-type counts are printed (F-38). The current phase is `BW_PHASE`, else 1 plus the highest merged `CP<n>` task on the integration branch (the
merged Task trailers, F-47); it has no default, and an unreadable phase exits 2 (F-39). `outside-origin-guard` asserts on its own when
the context closes, allows `file:` pages, blocks service workers (opt in with `serviceWorkers: 'allow'`) and routes WebSockets (F-40).
Browser tests are `*.pw.test.ts`, run only by `vitest.browser.config.ts`; the `unit-tests` gate excludes them, and
`ci/browser-test-guard.test.ts` (merge set) fails a `*.pw.test.ts` outside a gate directory (F-43) and a Playwright file (any .ts, .tsx, .js, .jsx, .mjs or .cjs, static or dynamic import) that opens a
context or page outside `guardedContext` (F-48; 2 local-page tools and 1 spike self-test against the hosted spike page, which is private tree only (J-35), are exempt by path, listed in the test). `BW_PW_ENGINES=chromium` narrows a local run on a machine without the WebKit build and then
requires `BW_PW_ENGINES_WHY=<reason>`; the run prints a DROPPED ENGINE notice (F-39) and `ci-verdict.json` records `engines` (run, dropped, why), so
`wave-run.sh --check-verdict` turns a narrowed run red (F-47). CI never sets either.

A lane that walks only its own pages (F-834): `BW_MERGED_TASKS` replaces the whole merged set, and an inventory row names the 1 task that
built its page. So name the row's task and the checkpoint before it, and run the walk itself: `BW_MERGED_TASKS=CP3,P4-BOARD pnpm exec vitest run
--config vitest.browser.config.ts ci/page-walkers/app.pw.test.ts` for the board map, whose screens sit on P4-BOARD's rows. `run-inventory.ts` exits 2
on that set, because it reads the earlier phases' rows as unmerged. A walk that reaches 0 screens stays red and says why.

A stack script takes its Compose project from its own variable, and a name off its pattern exits 2 before anything starts, so the reaper
only ever removes that script's project (F-834): `BW_BOARD_PROJECT` is `bw-w21-board` or `bw-w21-board-<x>`, and `BW_JOB_PROJECT` is
`bw-w22-job` or `bw-w22-job-<x>`, where `<x>` starts with a lowercase letter or digit. Each other stack's pattern is its script's `own_project`.

## license-gates (`ci/gates/license-gates.sh`, G-LICENSE)

`node ci/license-gates.ts [inventory|ios|all]` runs `license-inventory` and `ios-bundle-copyleft` (SPECIFICATIONS SD-39; FR-DIST-6, HC-07).
The gate script `ci/gates/license-gates.sh` runs `ci/license-gates.test.ts` (the planted known-bads under `ci/gates/license-gates/cases/`), then the real tree, and itself asserts the section 14 lines (VERIFIED or PENDING for the 3 npm entries, PENDING for the SPM and container entries) and the `never-shipped` list in the real-tree output (F-91, F-92: here-strings, no pipe, and the output is printed before a failed run exits).

- **Full tree**: `pnpm -r licenses list --json`. **Shipped** is two parts. (a) The server and web closure: `pnpm --filter <project> licenses list --json --prod` for each root in `shippedRoots` of `ci/license/policy.json` (`bw-web`, `bw-worker`, `bw-pbs`) and every workspace package they reach through `dependencies`. (b) The iPhone app's bundle: `pnpm exec expo export --platform ios --source-maps --output-dir <temp dir>` run in `apps/tech-native` (offline, nothing committed, the temp dir removed), then `name@version` from the `node_modules/.pnpm/...` paths in the source map's `sources`, with each license looked up in the full tree, plus the modules `expo-modules-autolinking resolve --platform apple --json` links into the app (native code ships although the bundle never imports it, F-84). A bundle source outside `node_modules` must be under `apps/` or `packages/` (or a Metro polyfill), the bundle has a floor (`bundleFloor` in `policy.json`), and a `shippedRoots` or `iosRoots` name the workspace lacks fails (F-85). Expo build tooling (`@expo/cli`'s helpers, `babel-preset-expo`, `@expo/metro-config`) is not in the Metro bundle, so it is not shipped. **Never shipped**: the full tree minus shipped, by name and version. The spike scripts folder (private tree only, J-35) is outside the workspace, so it is in neither set.
- Every shipped package is checked against the SD-39 allow-list in `ci/license/policy.json`. OR in an SPDX expression takes any allowed choice; AND needs every term. A missing license (pnpm prints `Unknown`) fails, shipped or not. Never-shipped tools may carry any license (OA-81); each is printed as `never-shipped <name>@<version>: <license>` (F-89), and the output prints the server and web closure count.
- `ios-bundle-copyleft` checks the `bw-tech-native` production closure (and any CocoaPods `Pods-*-acknowledgements.plist` under `apps/tech-native/ios/Pods`) for GPL, LGPL and AGPL.
- `node ci/license-gates.ts pods` (run after `bash apps/tech-native/xcuitest/prebuild.sh`) checks the native inputs the app links: the Pods in `ios/Podfile.lock` that are not first-party, the Swift packages the Xcode projects declare, any `Package.resolved` pins, and the acknowledgments plists, against the `build-verified.json` entries. It fails when no Xcode project exists yet.
- `ci/license/build-verified.json` records the 5 components of SPECIFICATIONS section 14 in 6 entries (the map library is split in 2). The entries have 3 kinds: `npm` (VERIFIED when found in the tree and equal, PENDING with `not in the lockfile yet` otherwise), `spm` (a Swift Package Manager package, PENDING `Swift Package Manager, outside the npm tree`) and `container` (PENDING `container, outside the npm tree`); a mismatch fails. A PENDING npm entry names its owning task (`owner`) and fails once that task has merged with the entry still PENDING (F-88). certbot, a container, is checked by the SHA-256 of its kept license text `ci/license/certbot-v5.8.0-LICENSE.txt`.
- **Known blind spots**: (1) the server and web part is by `dependencies` of the project, not by what a bundler imports, so a build tool listed under `dependencies` counts as shipped (over-reports) and a library bundled from `devDependencies` does not (under-reports); the iPhone part is exact for the JavaScript bundle only; (2) `ios-bundle-copyleft` still uses the whole `bw-tech-native` production closure, as SD-39 says, so it over-reports against the bundle (today it passes anyway); native code (CocoaPods, Swift packages) is covered by the `pods` mode (below) once `xcuitest/prebuild.sh` has made the Xcode project and Pods, and by the acknowledgments plist when one exists; with no prebuilt `apps/tech-native/ios` the `pods` mode fails loudly, and the Swift arm reads only the packages the projects declare and any `Package.resolved` pins; (3) licenses are the `license` field pnpm reads, not scanned license text; (4) PENDING entries are checked against the registry once (the source is cited in `ci/license/build-verified.json`) and re-checked against the tree only when the package lands in the lockfile; certbot is a container and is never tree-checked (its kept license text is hash-checked instead); (5) the bundle export runs a full Metro build (about 5 seconds plus startup) and needs `pnpm install --frozen-lockfile` and the Expo toolchain, and a failed export is exit 2 (cannot judge), never a pass.
- **Activation**: the marker `ci/active/license-gates` is present because the real tree runs green (exit 0, Nov 1, 2026).

## public-files-check (`ci/gates/public-files-check.sh`, P8-PUBLIC-FILES)

`node ci/public-files.ts [spdx|readme|copying|files|private-refs|all] [--root <dir>]` runs `spdx-header-check`, `readme-items` and `copying-ios-present` (SPECIFICATIONS section 6.13; FR-DIST-2, FR-DIST-4, FR-DIST-5, FR-DIST-7, OI-29), plus the data license and the `.env.example` seed (F-321). The gate script runs `ci/public-files.test.ts` (each check against a planted known-bad) and then the real tree.

- **The tree**: the files git knows (tracked, or new and not ignored) minus `scripts/private-paths.txt`, the list `scripts/publish.sh` uses.
- **spdx-header-check**: every source file (`.ts .tsx .mts .cts .mjs .cjs .js .jsx .swift .sh .py .rb .sql`, and an extensionless file that starts with `#!`) has `SPDX-License-Identifier: AGPL-3.0-or-later` in its first 3 lines (a shebang stays on line 1), and the check fails when it finds fewer than 1500 source files (`MIN_SOURCE_FILES`, `--floor <n>` overrides it for a test tree). `-only` and a bare `AGPL-3.0` fail. Styles, markup, JSON and config are not source files here. 1 prefix carries no header and is covered by `REUSE.toml`, which the check requires to name it: `packages/db/migrations/` (the migration runner stores each file's SHA-256, so a header would break every migrated database). `ci/vendor/` is private (F-1571) and is not in the export, so it needs no header. A new source file needs the header line (`# ` for shell, Python and Ruby after the shebang, `-- ` for SQL, `// ` for the rest).
- **readme-items**: the 5 items of FR-DIST-7, the Node and pnpm versions the README names equal `.node-version` and `package.json`, and `RESET_PROTECTION` within 3 lines of `DEMO_MODE`.
- **Activation**: the marker `ci/active/public-files-check`.

## G-CI4 inv4-one-clock-zoned-times (`ci/gates/G-CI4.sh`)

Invariant 4's clock half (P2-TIME; SPECIFICATIONS section 14 item 4; FR-DEMO-2, NFR-08). Wave gate, critical. 5 steps, each runs even after a red one:

1. The committed cases under `ci/gates/G-CI4/cases/` (W-38: every run, and in the merge set through `ci/gates/G-CI4/cases.test.ts`). `no-system-clock/*.txt`: each file names the path it is linted as (`// case-as:`) and its hit count (`// expect:`); the plants include `Date.now()` in `apps/web`, `new Date()`, `Date()`, `performance.timeOrigin`, `Temporal.Now`, a test file, a `.mjs` file, another file of `@bw/time`, and a read hidden by an `eslint-disable` comment. `realnow-sites/*.txt`: an unlisted tag, a variable tag, an alias, a value use, a re-export, computed access. `zone-reports/*.json`: a run with no probe, with a failure, with nothing passed.
2. The real tree: `node ci/gates/G-CI4/cli.ts tree`. No clock read in `apps/` or `packages/` outside `packages/time/src/real.ts`, linted with the repo's `eslint.config.mjs` and inline config off (the `lint` gate honors disable comments; this step does not). Then the listing of every `realNow` call site with its tag (`ci/gates/G-CI4/realnow-sites.ts`; the seam's own `packages/time/src` is not listed).
3. Every merge-set test, the DST suite (`packages/time/src/dst.test.ts`) among them, once per host zone: `TZ` and `BW_EXPECT_TZ` set to UTC, America/New_York and America/Los_Angeles in turn. `cli.ts zones` reads `.build/ci/G-CI4/tz-<zone>.json` and fails a zone whose host-zone probe did not pass (it checks the host's zone name and the host's own local hour of a fixed instant), whose run had a failure, or where nothing passed.
4. `DbClock` on the real `system.demo_clock` row, PostgreSQL 18 (`ci/gates/G-CI4/vitest.db.config.ts`).
5. `schema-time-zone-check` on the real schema (`node ci/gates/schema-gates/cli.ts --only tz`).

Lint scope: `no-system-clock` covers `apps/**` and `packages/**` (sources and tests). Exempt by path: `packages/time/src/real.ts` (the 1 reader) and the phase 1 spike probes `apps/*/spike/**` and `apps/tech-native/src/spike/**`.

## import-target-counts (`ci/gates/import-target-counts.sh`)

FR-IMP-6 and FR-IMP-3 (P2-IMPORT; SPECIFICATIONS section 6.7 "Target counts"). Wave gate, critical. Property: the import's dry run of the real generator output reports exactly every number of the FR-IMP-6 table in `docs/REQUIREMENTS.md` (read from the document, not from the generator), and its exact and likely pair sets equal `packages/generator/truth.json`; 811 exact matches, or any other count, fails.

1. The export: a fresh generation from seed 20260915, checked against `packages/generator/MANIFEST.json` (`generator-manifest`).
2. The import's database tests and the gate's planted cases (`ci/gates/import-target-counts/vitest.db.config.ts`, W-38: every run): a truth file with 1 exact pair removed fails the pairs property through the checker and through the CLI (exit 1); a report with 811 exact matches fails the counts property; an unreadable table makes it refuse to judge.
3. The real path: `node ci/gates/import-target-counts/cli.ts --measure` (a fresh PostgreSQL 18 database, the dry run as `bw_web`, the report read back from `import_run`). Its `ok` line is the record; the `OQ-19` line is the match-stage time (`docs/build/spikes/P2-IMPORT.md`).

## restore-test (`ci/gates/restore-test.sh`)

NFR-07, NFR-10 and OQ-12 (P3-BACKUP; SPECIFICATIONS section 11.7). Wave gate, critical. The local proofs of the backup scripts; the hosted half is the manager's `infra/backup/hosted-check.sh`, never this gate.

1. The backup stack (`infra/backup/tests/stack.sh up`) under the gate's own Compose project `bw-gate-backup` (`BW_RESTORE_GATE_PROJECT` may add a suffix), never a lane's `bw-w16-backup`. A stack left by an earlier killed run of that project is removed first.
2. The 8 proofs in `infra/backup/tests/backup.stack.test.ts` (`vitest.stack.config.ts`; the merge set excludes `*.stack.test.ts`).
3. The JSON report: every test passed, 0 skipped and 0 todo (a skip is a switched-off proof), and at least 8 tests (a shrink is red).

Exit: the stack's code when it cannot start (3: no docker), else the suite's own code, else 1 when the report check fails. Torn down on every exit path: an EXIT trap, and a detached reaper for the cap's SIGKILL to the process group. The state folder is `.build/ci/restore-test/` inside the tree, because the runner container bind-mounts it and only `/work` is shared with the wave run's engine (F-126). The suite mounts the engine socket that `DOCKER_HOST` names (`/var/run/dind/docker.sock` in the wave run), else `/var/run/docker.sock` (F-387). Plants and timings: `.build/evidence/P3-BACKUP-fix/`.

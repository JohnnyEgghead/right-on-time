#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate smoke-public-tag (P7-SMOKE; FR-DIST-8, UC-11; SPECIFICATIONS section 6.13, section 14 "Clean, for smoke-public-tag").
#   1. The verified release data the copy is staged with (the street list and the map files).
#   2. scripts/publish.sh --dry-run: the publish set, exported to a scratch folder; or, with --tag vX.Y.Z, that tag of the public repo
#      (https://github.com/JohnnyEgghead/right-on-time, or --repo <url>), cloned over the network (P8-PUBLISH).
#   3. ci/smoke/smoke-public-tag.sh: a copy of that export on a throwaway Docker-in-Docker engine, outside hosts blocked, Maria Santos
#      signed in and her 10:00 AM to 12:00 PM Harold Jenkins job found; any outside call at run time fails it; the engine is removed.
# The proofs that the job fails (a planted pre-pulled image, a planted container call, a planted page call) are in .build/evidence/P7-SMOKE/.
# The engine is named bw-p7-smoke-gate-<this pid>; if the gate is killed, a reaper outside its process group removes it (F-1485).
#   ci/gates/smoke-public-tag.sh [--tag vX.Y.Z [--repo <url>]]
# Exit: the job's (0 pass, 1 a check failed, 2 usage, 3 no usable docker), or 1 when the data or the export step failed.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)" || exit 1
tag=""
repo_url="https://github.com/JohnnyEgghead/right-on-time"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) tag="${2:-}"; shift 2 || { echo "smoke gate: --tag needs a value" >&2; exit 2; } ;;
    --repo) repo_url="${2:-}"; shift 2 || { echo "smoke gate: --repo needs a value" >&2; exit 2; } ;;
    *) echo "smoke gate: unknown argument $1 (usage: ci/gates/smoke-public-tag.sh [--tag vX.Y.Z [--repo <url>]])" >&2; exit 2 ;;
  esac
done
if [ -n "$tag" ] && ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "smoke gate: --tag $tag is not vX.Y.Z" >&2; exit 2; fi
[ -n "$repo_url" ] || { echo "smoke gate: --repo needs a value" >&2; exit 2; }
work="$(mktemp -d "${TMPDIR:-/tmp}/bw-smoke-gate.XXXXXX")"
# F-1485: run-gates SIGKILLs this process group on a timeout, so no trap runs and the job's own cleanup is skipped. A reaper in its own
# session (as ci/job-stack.sh starts one) waits for this script to die, then removes the engine and its harness by the names given here.
export ENGINE="bw-p7-smoke-gate-$$"
reaper="$(node -e '
  const c = require("node:child_process").spawn("bash", ["-c", "while kill -0 \"$1\" 2>/dev/null; do sleep 1; done; docker rm -fv \"$2\" \"$2-pw\" >/dev/null 2>&1; exit 0", "reap", process.argv[1], process.argv[2]], { detached: true, stdio: "ignore" });
  c.unref();
  console.log(c.pid);
' "$$" "$ENGINE")"
trap 'rm -rf "$work"; kill "$reaper" 2>/dev/null || true' EXIT
node ci/data-assets.ts ensure || exit 1
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps || exit 1
if [ -n "$tag" ]; then
  bash ci/smoke/smoke-public-tag.sh --data .build/data --tag "$tag" --repo "$repo_url" --out "$work/out"
else
  bash scripts/publish.sh --dry-run --out "$work/export" || exit 1
  bash ci/smoke/smoke-public-tag.sh --data .build/data --export "$work/export" --out "$work/out"
fi

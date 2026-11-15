#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P2-SETUP stack suite (BUILD_PLAN P2-SETUP Acceptance, the part moved from P2-SHELL by owner ruling c025a9ec):
# against the Compose stack after a fresh setup, through its proxy.
#   1. A plain stack: infra/compose.yaml with NO database env file (DB_ENV_FILE names a file that does not exist), as an
#      own copy has none. The db must come up healthy on the published own-copy default (F-96) and every service run.
#   2. The fresh setup in the stack: `docker compose --profile setup run --rm setup` (the image's packages/setup, as the
#      schema owner; the verified street list from .build/data). Its 'import started' and 'import committed' lines give
#      the real run's time on this machine.
#   3. 1 office session for Keisha Thompson (a seeded office user; sign-in is P2-AUTH's), then ci/setup-stack/check.ts:
#      API-130 finds job 24825, a street, both O'Briens; every number a sample Call control dials is in range.
# Run by ci/gates/import-target-counts.sh (step 4). Isolation as ci/shell-stack.sh (F-132): the project is named
# bw-setup-*, builds its own image tag <project>:local, and a reaper outside the process group tears it down if this
# script is killed. No docker: exit 3 ("stack unavailable", a red, never a skip).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-setup-[a-z0-9][a-z0-9_-]*$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "setup-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "setup-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
node ci/data-assets.ts ensure >/dev/null

project="${BW_SETUP_PROJECT:-bw-setup-$$}"
own_project "$project" || { echo "setup-stack: FAIL project name '$project' is refused (bw-setup-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-setup.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="$(freeport)"
https_port="$(freeport)"
seed="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')"
compose() {
  BW_IMAGE="$image" DB_ENV_FILE="$tmp/no-db-env-file" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port" \
    SAMPLE_PASSWORD_SEED="$seed" BW_DATA_DIR="$root/.build/data" docker compose -p "$project" -f infra/compose.yaml "$@"
}
reaper=""
cleanup() { stack_down "$project" "$image" "$tmp"; if [ -n "$reaper" ]; then kill "$reaper" 2>/dev/null || true; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
reaper="$(node -e '
  const c = require("node:child_process").spawn("bash", process.argv.slice(1), { detached: true, stdio: "ignore" });
  c.unref();
  console.log(c.pid);
' "$0" --reap "$$" "$project" "$image" "$tmp")"
echo "setup-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build web >/dev/null
echo "setup-stack: image built in $(( $(date +%s) - started )) s"
# 1. The plain own-copy stack (F-96): no database env file at all.
# F-1367 (cause: ci/shell-stack.sh, F-1415): routing is started too, as in the default stack, so reads that plan or time a day do not wait out the live-route budget.
compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing
running="$(compose ps --status running --services | sort | tr '\n' ' ')"
for s in db pbs proxy routing web worker; do
  grep -qw "$s" <<<"$running" || { echo "setup-stack: FAIL service $s is not running" >&2; exit 1; }
done
health="$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q db)")"
[ "$health" = "healthy" ] || { echo "setup-stack: FAIL the db is $health with no database env file (F-96)" >&2; exit 1; }
echo "setup-stack: own-copy stack up with no database env file; db $health (F-96)"

# 2. The fresh setup, from the image.
rc=0
compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || rc=$?
grep -E '"status":"(import started|import committed|setup done|setup refused)"|^setup: ' "$tmp/setup.log" || true
[ "$rc" -eq 0 ] || { echo "setup-stack: FAIL setup exited $rc" >&2; tail -5 "$tmp/setup.log" >&2; exit 1; }
node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const t = (s) => Date.parse((lines.find((l) => l.status === s) || {}).realTime);
  const ms = t("import committed") - t("import started");
  if (!Number.isFinite(ms)) { console.error("setup-stack: FAIL no import started/committed lines"); process.exit(1); }
  console.log(`setup-stack: real import run ${(ms / 60000).toFixed(2)} min from its log_stamp lines`);
' "$tmp/setup.log"

# 3. The office session and the checks.
token="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
psql() { compose exec -T db psql -q -U brightwater -d brightwater -v ON_ERROR_STOP=1 "$@"; }
psql -v token="$token" >/dev/null <<'SQL'
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(:'token', 'UTF8')), id, 'web', 'password', false, now(), now(), now() + interval '1 hour'
  FROM world."user" WHERE email = 'keisha.t@brightwater.example';
SQL
psql -tA -c "SELECT mobile FROM world.customer WHERE mobile IS NOT NULL UNION SELECT home_phone FROM world.customer WHERE home_phone IS NOT NULL UNION SELECT phone FROM world.technician" >"$tmp/numbers"
psql -tA -c "SELECT office_phone FROM world.branch" >"$tmp/offices"
cat "$tmp/offices" >>"$tmp/numbers"
address="$(psql -tA -c "SELECT c.house_number || '|' || s.name || '|' || s.city FROM world.customer c JOIN world.street s ON s.id = c.street_id WHERE c.name = 'Harold Jenkins'")"
node ci/setup-stack/check.ts "http://127.0.0.1:$port" "$token" "$tmp/numbers" "$tmp/offices" "$address"

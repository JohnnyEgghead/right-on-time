#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Publish script (SPECIFICATIONS section 6.13 FR-DIST-1, FR-DIST-3, SD-38, SD-40; P8-PUBLISH).
#   scripts/publish.sh --dry-run [--ref <tag|commit>] [--out <dir>] [--list <file>] [--release-tag <vX.Y.Z> [--slug <owner/repo>]]
#   scripts/publish.sh prepare <vX.Y.Z> [--ref <ref>] [--clone <dir>] [--remote <url>] [--slug <owner/repo>]
#   scripts/publish.sh image   <vX.Y.Z> [--clone <dir>] [--docker-context <name>]
#   scripts/publish.sh push    <vX.Y.Z> --granted [--clone <dir>]
#   scripts/publish.sh release <vX.Y.Z> --granted [--clone <dir>] [--data <dir>]
#   scripts/publish.sh docs [--ref <ref>] [--clone <dir>] [--remote <url>] [--dry-run] [--granted]
#   scripts/publish.sh --help
#
# --dry-run exports the publish set: the tree at <ref> (default HEAD) minus the private paths list (scripts/private-paths.txt), into
# <out> (default a new temp dir; it must be absent or empty), and writes the exported paths, 1 per line, sorted, to <list> (default
# <out>.list). With --release-tag, the 2 data manifests in the export (the map files, the street list) name the public release
# (<slug>, default JohnnyEgghead/right-on-time, and that tag) for every asset, so an own copy downloads from the public repo.
# Private paths list lines: a path, a directory (trailing /), **/<name> at any depth, or a glob with a * (F-1454).
#   exit 1  the export holds a private path, a .github directory at any depth, or a full device id (UDID): nothing is to be published
#           from it (F-55: the S4 record's identifiers are truncated, and this keeps them so)
#   exit 2  usage error
#
# The release steps (SD-40), each re-runnable; state is kept in <clone>/.git/bw-publish/<tag>.env:
#   prepare  the dry run with --release-tag into a scratch folder (under TMPDIR, removed at the end), the secret scan of that export (gitleaks, both passes),
#            then, in a clone of the public repo (default .build/publish/right-on-time), 1 commit whose parent is the public main and
#            whose tree is the export (checked blob for blob against the private tree), plus the named files only the public main has
#            (PUBLIC_ONLY of scripts/publish-assets.ts, its CONTRIBUTING.md: kept), and an annotated tag on it, both local only. F-1682:
#            any other path of the public main the export lacks (deleted, renamed or made private since) is dropped, and named.
#            The commit's author and committer are the public main's author, its date the private commit's: the same inputs make the
#            same commit, so a re-run is a no-op. An unpushed local tag is replaced. A tag already public is never moved: with the
#            same tree prepare reports it and stops (exit 0), with another tree it refuses (exit 1).
#            F-1620: the public files check (all, with ipv4 and private-refs) runs on the commit before any tag or state names it; the
#            tag, then the state, are written last, with PREPARED=1 the very last line. A prepare of an unpushed tag that stops on any
#            check leaves it not prepared (PREPARED=0, or no state at all), and image, push and release refuse it. F-1622: the private
#            paths list is read from the ref that is exported, never from the working tree.
#   image    the release image from the tag's tree only (git archive), linux/amd64, PUBLIC_COMMIT and the revision label set to the
#            public commit, loaded as bw-app:<tag>; then, inside the image, the real config and the app-info handler give the footer's
#            Source link <SOURCE_REPO_URL>/commit/<public commit> (and follow a SOURCE_REPO_URL override); the notices file is there.
#            F-1624 (SD-40 step 3: linux/amd64, natively, on Spectre): built on the Docker engine of context spectre by default;
#            --docker-context <name> (or BW_PUBLISH_DOCKER_CONTEXT) names another. The state records the image id, commit and context.
#   push     (owner grant only: without --granted it prints what it would do and exits 3) re-checks the tag's tree and re-scans it, then
#            pushes the commit to main and the tag in 1 atomic push, never forced; the public main must still be the commit's parent.
#            F-1618: push and release first check the release image (exit 1 before any network call, granted or not): the image the
#            image step checked for this prepared commit, still bw-app:<tag> with that id, PUBLIC_COMMIT and revision label.
#   release  (owner grant only, exit 3 without --granted) checks every data file the tag's manifests name (size and SHA-256, under
#            <data>, default .build/data: maps/<name>, and the street list at the top), creates the GitHub release as a draft, uploads
#            what is missing, replaces what differs, publishes it, and checks every asset's size and sha256 digest. A published release
#            whose assets differ is refused (it is never changed by this script).
#   docs     (between releases; owner grant only) puts only PRIVACY.md and SUPPORT.md of <ref> (default HEAD) on the public main: the
#            files must be in the dry-run export, byte for byte the private ones, and pass the secret scan; 1 commit on the public
#            main whose tree differs from it in those 2 paths only, pushed without a tag and never forced. --dry-run builds and
#            checks the commit and prints what it would push (exit 0); without --granted it prints the same and exits 3.
# Exit 0 done, 1 a check failed, 2 usage, 3 a grant step without --granted. Only push and release write outside this machine.
# Test seams: BW_PUBLISH_SCAN (run as "<it> dir <path>") and BW_PUBLISH_FILES (run as "<it> <path>") stand in for the 2 checks,
# BW_GH and BW_DOCKER for gh and docker.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
usage() { sed -n '3,10p' "$root/scripts/publish.sh" | sed 's/^# //' >&2; }

sub=dry
case "${1:-}" in
  prepare|image|push|release|docs) sub="$1"; shift ;;
  -h|--help) sed -n '3,53p' "$root/scripts/publish.sh" | sed -e 's/^# \{0,1\}//'; exit 0 ;;
esac

dry=0
ref="HEAD"
out=""
list=""
rtag=""
slug="JohnnyEgghead/right-on-time"
tag=""
clone="$root/.build/publish/right-on-time"
remote="https://github.com/JohnnyEgghead/right-on-time.git"
data="$root/.build/data"
dctx="${BW_PUBLISH_DOCKER_CONTEXT:-spectre}"
granted=0
if [ "$sub" = docs ]; then
  tag=docs
elif [ "$sub" != dry ]; then
  tag="${1:-}"
  [ -n "$tag" ] && [ "${tag#-}" = "$tag" ] || { usage; exit 2; }
  shift
fi
while [ "$#" -gt 0 ]; do
  case "$sub:$1" in
    dry:--dry-run) dry=1; shift ;;
    dry:--out) out="${2:?--out needs a value}"; shift 2 ;;
    dry:--list) list="${2:?--list needs a value}"; shift 2 ;;
    dry:--release-tag) rtag="${2:?--release-tag needs a value}"; shift 2 ;;
    dry:--ref|prepare:--ref|docs:--ref) ref="${2:?--ref needs a value}"; shift 2 ;;
    dry:--slug|prepare:--slug|docs:--slug) slug="${2:?--slug needs a value}"; shift 2 ;;
    docs:--dry-run) dry=1; shift ;;
    prepare:--remote|docs:--remote) remote="${2:?--remote needs a value}"; shift 2 ;;
    prepare:--clone|docs:--clone|image:--clone|push:--clone|release:--clone) clone="${2:?--clone needs a value}"; shift 2 ;;
    release:--data) data="${2:?--data needs a value}"; shift 2 ;;
    image:--docker-context) dctx="${2:?--docker-context needs a value}"; shift 2 ;;
    push:--granted|release:--granted|docs:--granted) granted=1; shift ;;
    *) usage; exit 2 ;;
  esac
done
tag_ok() { [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "publish: a release tag looks like v1.2.3, not '$1'" >&2; exit 2; }; }
[[ "$slug" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "publish: --slug must be owner/repo, not '$slug'" >&2; exit 2; }

# ---------------------------------------------------------------------------------------------------------------------------- dry run
dry_run() {
  # F-1694, F-1639: a guard that stopped under load left no stderr; name the line and the exit status the dry run stopped at, so the next red says which.
  set -E
  trap 'rc=$?; echo "publish: the dry run stopped at line $LINENO (exit $rc): $BASH_COMMAND" >&2' ERR
  cd "$root"
  git rev-parse --verify --quiet "$ref^{tree}" >/dev/null || { echo "publish: no such ref: $ref" >&2; exit 2; }
  if [ -n "$rtag" ]; then tag_ok "$rtag"; fi
  if [ -z "$out" ]; then out="$(mktemp -d "${TMPDIR:-/tmp}/bw-publish.XXXXXX")"; fi
  mkdir -p "$out"
  if [ -n "$(ls -A "$out")" ]; then echo "publish: --out $out is not empty" >&2; exit 2; fi
  out="$(cd "$out" && pwd)"
  [ -n "$list" ] || list="$out.list"

  # The private paths list: directories (trailing /), files, and **/<name> for a component at any depth.
  # F-1622: the list of the ref that is exported (git archive of <ref> below), never the working tree's, so an edit not committed
  # at <ref> cannot let a private path out.
  local dirs=() files=() anydepth=() globs=() line plist
  plist="$(git show "$ref:scripts/private-paths.txt")" || { echo "publish: $ref has no scripts/private-paths.txt" >&2; exit 2; }
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      '**/'*) anydepth+=("${line#'**/'}") ;;
      *'*'*)
        # F-1683: * is the only wildcard (the guard below reads a glob line as a regex, the removal as a shell glob).
        case "$line" in *'?'* | *'['*) echo "publish: a private paths glob line uses no ? or [, only *: $line" >&2; exit 2 ;; esac
        globs+=("$line") ;;
      */) dirs+=("${line%/}") ;;
      *) files+=("$line") ;;
    esac
  done <<<"$plist"

  # F-1639, F-1694, F-1823: a file, not a pipe. Under pipefail, tar stopping at the end-of-archive blocks while git archive still writes its
  # padding gave exit 141 (SIGPIPE) under load.
  local tarf; tarf="$(mktemp "${TMPDIR:-/tmp}/publish-archive.XXXXXX")"
  git archive --format=tar -o "$tarf" "$ref" || { rm -f "$tarf"; exit 1; }
  tar -xf "$tarf" -C "$out" || { rm -f "$tarf"; exit 1; }
  rm -f "$tarf"
  local total kept bad=0 d f n g re udid udid_split
  total="$(cd "$out" && find . -type f -o -type l | wc -l | tr -d ' ')"

  for d in "${dirs[@]}"; do rm -rf "${out:?}/$d"; done
  for f in "${files[@]}"; do rm -f "${out:?}/$f"; done
  for n in "${anydepth[@]}"; do
    find "$out" -name "$n" -prune -exec rm -rf {} +
  done
  # F-1454: a glob line (a * matches within 1 path part): every file the pattern names is removed.
  for g in ${globs[@]+"${globs[@]}"}; do
    (cd "$out" && shopt -s nullglob && for p in $g; do rm -rf -- "$p"; done)
  done
  # F-364(b), F-1572: the public tree's manifests name the public release, so an own copy downloads from the public repo.
  if [ -n "$rtag" ]; then node "$root/scripts/publish-assets.ts" rewrite "$out" "$slug" "$rtag" || exit 1; fi

  (cd "$out" && find . \( -type f -o -type l \) | sed 's|^\./||' | LC_ALL=C sort) > "$list"
  kept="$(wc -l < "$list" | tr -d ' ')"

  # Guards over what is left (they hold even if the list above is edited wrongly).
  for d in "${dirs[@]}"; do
    if grep -q -e "^$d/" "$list"; then echo "publish: FAIL private path in the export: $d/" >&2; bad=1; fi
  done
  for f in "${files[@]}"; do
    if grep -q -x -e "$f" "$list"; then echo "publish: FAIL private path in the export: $f" >&2; bad=1; fi
  done
  # F-1683: every regex character of a glob line but its * is escaped, and the glob names a file or a folder, so the guard matches
  # the path itself or anything under it (a line ending in / names folders only, so anything under them).
  for g in ${globs[@]+"${globs[@]}"}; do
    re="$(printf '%s' "${g%/}" | sed -e 's/[]\.^$+(){}|[]/\\&/g' -e 's|[*]|[^/]*|g')"
    if [ "${g%/}" != "$g" ]; then re="^${re}/"; else re="^${re}(/|\$)"; fi
    if grep -q -E -e "$re" "$list"; then echo "publish: FAIL private path in the export: $g" >&2; bad=1; fi
  done
  for n in "${anydepth[@]}"; do
    if grep -q -e "^$n/" -e "/$n/" -e "/$n\$" -e "^$n\$" "$list"; then echo "publish: FAIL $n in the export" >&2; bad=1; fi
  done
  # A full device id (8 hex, a dash, 16 hex) is the owner's iPhone: only a truncated form may be published (F-55).
  udid="$(grep -rIlE '(^|[^0-9A-Fa-f])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}([^0-9A-Fa-f]|$)' "$out" 2>/dev/null || true)"
  # F-1452: and the same id cut by quotes, braces, a plus or a template (8 hex, a dash, 1 to 8 of those characters, 16 hex), as a test file may hold it.
  udid_split="$(grep -rIlE "[0-9A-Fa-f]{8}-['\"+ \$\{\}\`]{1,8}[0-9A-Fa-f]{16}([^0-9A-Fa-f]|\$)" "$out" 2>/dev/null || true)"
  udid="$(printf '%s\n%s\n' "$udid" "$udid_split" | sed '/^$/d' | LC_ALL=C sort -u)"
  if [ -n "$udid" ]; then
    echo "publish: FAIL a full device id (UDID shape) is in:" >&2
    printf '%s\n' "$udid" | sed "s|^$out/|  |" >&2
    bad=1
  fi

  echo "publish: dry run of $ref: $total path(s) in the tree, $((total - kept)) left out, $kept exported"
  echo "publish: export $out"
  echo "publish: list $list"
  [ "$bad" -eq 0 ] || exit 1
  echo "publish: PASS"
}

# ------------------------------------------------------------------------------------------------------------------ the release steps
die() { echo "publish: FAIL $*" >&2; exit 1; }
g() { git -C "$clone" "$@"; }
GH="${BW_GH:-gh}"
DOCKER="${BW_DOCKER:-docker}"
# Scratch for 1 run (the export, the image context, the release listings): a fresh folder outside the repo, so lint, the tests and the
# other tools of this checkout never see a second copy of the source, and removed when the run ends, pass or fail.
work=""
mkwork() { work="$(mktemp -d "${TMPDIR:-/tmp}/bw-publish-$tag.XXXXXX")"; trap 'rm -rf "$work"' EXIT; }
state="$clone/.git/bw-publish/$tag.env"
state_get() { [ -f "$state" ] && grep -E "^$1=" "$state" | tail -1 | cut -d= -f2- || true; }
state_set() {
  mkdir -p "$(dirname "$state")"
  { [ -f "$state" ] && grep -v -E "^$1=" "$state" || true; printf '%s=%s\n' "$1" "$2"; } > "$state.new"
  mv "$state.new" "$state"
}
state_del() { [ -f "$state" ] || return 0; { grep -v -E "^$1=" "$state" || true; } > "$state.new"; mv "$state.new" "$state"; }
run_scan() { if [ -n "${BW_PUBLISH_SCAN:-}" ]; then "$BW_PUBLISH_SCAN" dir "$1"; else node "$root/ci/secret-scan/scan.ts" dir "$1"; fi; }
run_files() { if [ -n "${BW_PUBLISH_FILES:-}" ]; then "$BW_PUBLISH_FILES" "$1"; else node "$root/ci/public-files.ts" all --root "$1" --export; fi; }
# F-1714: the docs-only folder gets the content checks prepare gives the export (ipv4, private-refs, owner-ids); the others (SPDX, README items) are about the whole tree.
run_docs_files() { if [ -n "${BW_PUBLISH_FILES:-}" ]; then "$BW_PUBLISH_FILES" "$1"; else local c; for c in ipv4 private-refs owner-ids; do node "$root/ci/public-files.ts" "$c" --root "$1" || return 1; done; fi; }
# The prepared tag, checked against the state file: sets commit, tree, base.
load_prepared() {
  [ -f "$state" ] || die "no prepared release $tag in $clone (run scripts/publish.sh prepare $tag first)"
  # F-1620: PREPARED=1 is written last, after every check passed; a prepare that stopped on a check left 0 or nothing.
  [ "$(state_get PREPARED)" = 1 ] || die "the release $tag is not prepared: its last prepare did not pass every check (run scripts/publish.sh prepare $tag)"
  commit="$(state_get COMMIT)"
  tree="$(state_get TREE)"
  base="$(state_get BASE)"
  [ "$(g rev-parse --verify --quiet "refs/tags/$tag^{commit}" || true)" = "$commit" ] || die "the local tag $tag is not the prepared commit $commit"
  [ "$(g rev-parse "$commit^{tree}")" = "$tree" ] || die "the prepared commit's tree is not $tree"
}
# F-1618: the release image, bound to the prepared commit. push and release call it before anything else they do (granted or not,
# before any network call): the image the image step checked for this commit, in the engine it was built on, still bw-app:<tag> with
# the same id, and PUBLIC_COMMIT and the revision label the prepared commit. A missing or stale image is refused (exit 1).
image_bound() {
  local id ic ictx img got env
  id="$(state_get IMAGE_ID)"; ic="$(state_get IMAGE_COMMIT)"; ictx="$(state_get IMAGE_CONTEXT)"; img="bw-app:$tag"
  [ -n "$id" ] && [ -n "$ictx" ] || die "no release image is checked for the prepared commit $commit: run scripts/publish.sh image $tag first"
  [ "$ic" = "$commit" ] || die "the checked release image was built for $ic, not the prepared commit $commit: run scripts/publish.sh image $tag again"
  got="$("$DOCKER" --context "$ictx" image inspect --format '{{.Id}}' "$img" 2>/dev/null)" || die "the release image $img is not in the Docker engine of context $ictx: run scripts/publish.sh image $tag"
  [ "$got" = "$id" ] || die "$img (context $ictx) is now another image ($got), not the one checked for $commit ($id): run scripts/publish.sh image $tag again"
  env="$("$DOCKER" --context "$ictx" image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$img")" || die "reading the env of $img"
  printf '%s\n' "$env" | grep -q -x -e "PUBLIC_COMMIT=$commit" || die "the PUBLIC_COMMIT of $img is not the prepared commit $commit (a stale image): run scripts/publish.sh image $tag again"
  got="$("$DOCKER" --context "$ictx" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img")" || die "reading the labels of $img"
  [ "$got" = "$commit" ] || die "the revision label of $img is '$got', not the prepared commit $commit (a stale image): run scripts/publish.sh image $tag again"
  echo "publish: the release image $img ($id, context $ictx) carries the prepared commit $commit"
}
# The tag's tree as files in a fresh folder (the image context and the push re-scan).
archive_to() {
  local tarf; rm -rf "$1"; mkdir -p "$1"; tarf="$(mktemp "${TMPDIR:-/tmp}/publish-archive.XXXXXX")"
  g archive --format=tar -o "$tarf" "refs/tags/$tag" || { rm -f "$tarf"; return 1; }
  tar -xf "$tarf" -C "$1" || { rm -f "$tarf"; return 1; }
  rm -f "$tarf"   # a file, not a pipe (F-1823: SIGPIPE 141 under load)
}
# The sha of 1 ref of the public repo, by its exact name (empty when absent); --refs leaves out the peeled ^{} lines.
remote_ref() { g ls-remote --refs origin "$1" | awk -v r="$1" '$2 == r { print $1 }'; }

prepare() {
  tag_ok "$tag"
  local priv out list idx tree base name email when commit rt rtree n carried dropped cand img_id img_commit img_ctx
  priv="$(git -C "$root" rev-parse --verify --quiet "$ref^{commit}")" || { echo "publish: no such ref: $ref" >&2; exit 2; }
  # F-1620: from here until every check has passed, an unpushed tag is not prepared, so a prepare that stops on a check leaves
  # nothing image, push or release would take. (A pushed tag's state records what is public; prepare never changes that.)
  if [ -f "$state" ] && [ "$(state_get PUSHED)" != 1 ]; then state_set PREPARED 0; fi
  out="$work/export"
  list="$work/export.list"
  bash "$root/scripts/publish.sh" --dry-run --ref "$priv" --out "$out" --list "$list" --release-tag "$tag" --slug "$slug" || die "the export of $ref did not pass its guards"
  if grep -q -E '^docs/planning/|(^|/)\.github/' "$list"; then die "the export holds docs/planning or a .github folder"; fi
  run_scan "$out" || die "the secret scan of the export"

  # The public repo: a clone of it (reads only).
  if [ -d "$clone/.git" ]; then
    [ "$(g remote get-url origin)" = "$remote" ] || die "$clone is a clone of $(g remote get-url origin), not $remote"
    g fetch --quiet origin '+refs/heads/*:refs/remotes/origin/*'
  else
    mkdir -p "$(dirname "$clone")"
    git clone --quiet --no-checkout "$remote" "$clone"
  fi
  base="$(g rev-parse --verify --quiet refs/remotes/origin/main)" || die "the public repo has no main branch"

  # The tree: the export, added to an empty index of the clone (so the clone's own files and ignore rules play no part).
  idx="$work/index"
  rm -f "$idx"
  (cd "$out" && GIT_INDEX_FILE="$idx" git --git-dir="$clone/.git" --work-tree="$out" -c core.autocrlf=false -c core.safecrlf=false add -A -f .) || die "the export could not be added"
  # A file only the public main has, by name (PUBLIC_ONLY: its CONTRIBUTING.md), is kept as it is. F-1682: every other public main
  # path the export lacks is dropped (a file deleted, renamed or made private stays out of the release), and named below.
  g ls-tree -r -z "$base" > "$work/base.tree"
  node "$root/scripts/publish-assets.ts" carry "$work/base.tree" "$list" > "$work/carry.idx" || die "the carried files of the public main"
  GIT_INDEX_FILE="$idx" git --git-dir="$clone/.git" update-index -z --index-info < "$work/carry.idx"
  carried="$(tr '\0' '\n' < "$work/carry.idx" | cut -f2 | paste -sd ' ' -)"
  dropped="$(node "$root/scripts/publish-assets.ts" dropped "$work/base.tree" "$list" | paste -sd ' ' -)" || die "the dropped files of the public main"
  tree="$(GIT_INDEX_FILE="$idx" git --git-dir="$clone/.git" write-tree)"
  # Blob for blob: the public tree is the export plus the carried files, and every exported file but the 2 rewritten manifests is
  # the private tree's own.
  git -C "$root" ls-tree -r -z --full-tree "$priv" > "$work/private.tree"
  g ls-tree -r -z "$tree" > "$work/public.tree"
  node "$root/scripts/publish-assets.ts" same-tree "$work/private.tree" "$work/public.tree" "$list" "$work/base.tree" || die "the public tree is not the export"
  n="$(wc -l < "$list" | tr -d ' ')"

  # A tag already public is never moved.
  rt="$(remote_ref "refs/tags/$tag")"
  if [ -n "$rt" ]; then
    g fetch --quiet origin "+refs/tags/$tag:refs/tags/$tag"
    rtree="$(g rev-parse "refs/tags/$tag^{tree}")"
    [ "$rtree" = "$tree" ] || die "the tag $tag is already public with another tree ($rtree); a public tag is never moved: prepare the next version"
    state_set TAG "$tag"; state_set COMMIT "$(g rev-parse "refs/tags/$tag^{commit}")"; state_set TREE "$tree"
    state_set BASE "$(g rev-parse "refs/tags/$tag^{commit}^")"; state_set PRIVATE "$priv"; state_set SLUG "$slug"; state_set PUSHED 1
    state_set PREPARED 1
    echo "publish: $tag is already public with this same tree (commit $(state_get COMMIT)): nothing to prepare"
    return 0
  fi

  name="${BW_PUBLISH_NAME:-$(g log -1 --format=%an "$base")}"
  email="${BW_PUBLISH_EMAIL:-$(g log -1 --format=%ae "$base")}"
  when="$(git -C "$root" log -1 --format=%cI "$priv")"
  export GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_AUTHOR_DATE="$when"
  export GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" GIT_COMMITTER_DATE="$when"
  commit="$(printf 'Right On Time %s\n\nThe source of the app at release %s.\n' "$tag" "$tag" | g commit-tree --no-gpg-sign -p "$base" "$tree")"

  # F-1620: the public files check (it lists files with git, so it reads a checkout) runs on the commit before any tag or state names
  # it: a fetch of the commit over the file:// transport, as a reader gets it, through a temporary ref that is removed pass or fail.
  cand="refs/bw-publish/candidate-$tag"
  g update-ref "$cand" "$commit"
  git init --quiet "$work/checkout"
  if ! git -C "$work/checkout" fetch --quiet --no-tags "file://$clone" "+$cand:refs/heads/candidate"; then g update-ref -d "$cand"; die "fetching the candidate commit"; fi
  g update-ref -d "$cand"
  git -C "$work/checkout" -c advice.detachedHead=false checkout --quiet --detach refs/heads/candidate
  [ "$(git -C "$work/checkout" rev-parse HEAD)" = "$commit" ] || die "the checkout is not the candidate commit $commit"
  run_files "$work/checkout" || die "the public files check of the candidate commit (nothing is prepared)"

  # Every check passed: the tag, then the state, with PREPARED=1 the last line written.
  if g rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
    echo "publish: replacing the unpushed local tag $tag (it was $(g rev-parse "refs/tags/$tag^{commit}"))"
    g tag -d "$tag" >/dev/null
  fi
  g -c tag.gpgSign=false tag -a "$tag" -m "Right On Time $tag" "$commit"
  img_id="$(state_get IMAGE_ID)"; img_commit="$(state_get IMAGE_COMMIT)"; img_ctx="$(state_get IMAGE_CONTEXT)"
  rm -f "$state"
  state_set TAG "$tag"; state_set COMMIT "$commit"; state_set TREE "$tree"; state_set BASE "$base"
  state_set PRIVATE "$priv"; state_set SLUG "$slug"; state_set PUSHED 0
  # F-1618: the image checked for this same commit (a re-run with the same inputs makes the same commit) stays recorded; an image of
  # another commit is dropped, so push and release refuse until image is run again. push and release re-check the image itself.
  if [ -n "$img_id" ] && [ "$img_commit" = "$commit" ]; then
    state_set IMAGE_ID "$img_id"; state_set IMAGE_COMMIT "$img_commit"; state_set IMAGE_CONTEXT "$img_ctx"
  fi
  state_set PREPARED 1
  echo "publish: prepared $tag in $clone: commit $commit (parent $base, the public main), tree $tree, $n files, from private commit $priv"
  echo "publish: kept from the public main (files the export does not have): ${carried:-none}"
  echo "publish: dropped from the public main (not in the export, not a public-only file): ${dropped:-none}"
  echo "publish: nothing was pushed. Next: scripts/publish.sh image $tag, then (owner grant) push $tag --granted and release $tag --granted"
}

image() {
  tag_ok "$tag"
  local commit tree base ctx img want got js rc
  load_prepared
  # F-1618: the build replaces bw-app:<tag>, so the record of the image checked before goes first: a run that stops on a check leaves
  # no checked image, and push and release refuse until a run passes every check.
  state_del IMAGE_ID; state_del IMAGE_COMMIT; state_del IMAGE_CONTEXT
  ctx="$work/image-ctx"
  archive_to "$ctx"
  img="bw-app:$tag"
  # F-1624: on the engine of context $dctx (spectre by default: SD-40 step 3 builds linux/amd64 natively on Spectre).
  D() { "$DOCKER" --context "$dctx" "$@"; }
  echo "publish: building $img for linux/amd64 on the Docker engine of context $dctx"
  D buildx build --platform linux/amd64 -f "$ctx/infra/image/Dockerfile" --target release \
    --build-arg "PUBLIC_COMMIT=$commit" --build-arg "SOURCE_COMMIT=$commit" --load -t "$img" "$ctx" || die "the image build"
  got="$(D image inspect --format '{{.Os}}/{{.Architecture}}' "$img")"
  [ "$got" = linux/amd64 ] || die "the image is $got, not linux/amd64"
  D image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$img" | grep -q -x -e "PUBLIC_COMMIT=$commit" || die "the image's PUBLIC_COMMIT is not $commit"
  got="$(D image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img")"
  [ "$got" = "$commit" ] || die "the image's revision label is '$got', not $commit"
  # FR-DIST-3 through the real code: the image's own config loader and app-info handler (API-02) make the footer's Source link.
  js="import { loadConfig } from '/app/packages/config/src/index.ts';
import { appInfoHandler } from '/app/packages/api-server/src/handlers/auth.ts';
import { existsSync } from 'node:fs';
const r = await appInfoHandler({ params: {} }, null, { settings: loadConfig(process.env) });
console.log(JSON.stringify({ status: r.status, sourceUrl: r.data.sourceUrl, sourceCommit: r.data.sourceCommit, notices: existsSync('/app/THIRD-PARTY-NOTICES.md') }));"
  for pair in "-|https://github.com/JohnnyEgghead/right-on-time" "https://example.org/own/copy/|https://example.org/own/copy"; do
    local set="${pair%%|*}" repo="${pair#*|}" envarg=()
    [ "$set" = - ] || envarg=(-e "SOURCE_REPO_URL=$set")
    got="$(D run --rm --platform linux/amd64 --network none ${envarg[@]+"${envarg[@]}"} --entrypoint node "$img" --input-type=module -e "$js")" || die "the in-image app-info check did not run"
    want="{\"status\":200,\"sourceUrl\":\"$repo/commit/$commit\",\"sourceCommit\":\"$commit\",\"notices\":true}"
    [ "$got" = "$want" ] || die "app-info in the image gave $got, wanted $want"
    echo "publish: in the image, app-info (SOURCE_REPO_URL ${set/#-/default}) gives Source link $repo/commit/$commit; THIRD-PARTY-NOTICES.md is there"
  done
  # F-1618: the image is bound to the commit it was checked for, by its id and its engine; push and release check all 3.
  state_set IMAGE_ID "$(D image inspect --format '{{.Id}}' "$img")"; state_set IMAGE_COMMIT "$commit"; state_set IMAGE_CONTEXT "$dctx"
  echo "publish: image $img ($(state_get IMAGE_ID)), linux/amd64, context $dctx, public commit $commit; not pushed anywhere"
}

plan_only() {
  echo "publish: $sub $tag writes to the public repo $(state_get SLUG); it runs only with --granted (the owner's grant). It would run:"
  printf '  %s\n' "$@"
  exit 3
}

push() {
  tag_ok "$tag"
  local commit tree base rmain rt lt refs=()
  load_prepared
  image_bound
  [ "$granted" -eq 1 ] || plan_only "git -C $clone push --atomic origin $commit:refs/heads/main refs/tags/$tag:refs/tags/$tag" \
    "(after re-checking the tag's tree $tree and re-scanning it; public main must still be $base)"
  archive_to "$work/push-check"
  run_scan "$work/push-check" || die "the re-scan of the tag's tree"
  rmain="$(remote_ref refs/heads/main)"
  rt="$(remote_ref "refs/tags/$tag")"
  lt="$(g rev-parse "refs/tags/$tag")"
  if [ "$rmain" = "$commit" ] && [ "$rt" = "$lt" ]; then
    state_set PUSHED 1
    echo "publish: $tag and main are already public at $commit: nothing to push"
    return 0
  fi
  [ -z "$rt" ] || [ "$rt" = "$lt" ] || die "the public repo has another tag $tag ($rt); a public tag is never moved"
  if [ "$rmain" != "$commit" ]; then
    [ "$rmain" = "$base" ] || die "the public main is now $rmain, not the prepared parent $base: run prepare $tag again"
    refs+=("$commit:refs/heads/main")
  fi
  [ -n "$rt" ] || refs+=("refs/tags/$tag:refs/tags/$tag")
  g push --atomic origin "${refs[@]}" || die "the push"
  [ "$(remote_ref refs/heads/main)" = "$commit" ] || die "after the push the public main is not $commit"
  [ "$(remote_ref "refs/tags/$tag")" = "$lt" ] || die "after the push the public tag $tag is not $lt"
  state_set PUSHED 1
  echo "publish: pushed $tag: main and the tag are public at $commit"
}

release() {
  tag_ok "$tag"
  local commit tree base maps street files rels notes cmp cmp_ok x f
  load_prepared
  slug="$(state_get SLUG)"
  image_bound
  [ "$granted" -eq 1 ] || plan_only "node scripts/publish-assets.ts check (every data file under $data against the tag's manifests)" \
    "$GH release create $tag --repo $slug --verify-tag --draft --title 'Right On Time $tag' --notes-file <notes>" \
    "$GH release upload $tag <each missing file> --repo $slug (--clobber for one that differs)" \
    "$GH release edit $tag --repo $slug --draft=false, then the size and digest of every asset"
  [ "$(state_get PUSHED)" = 1 ] || die "the tag $tag is not public yet: run push $tag --granted first"
  [ "$(remote_ref "refs/tags/$tag")" = "$(g rev-parse "refs/tags/$tag")" ] || die "the public tag $tag is not the prepared one"
  maps="$work/release-maps.json"
  street="$work/release-street.json"
  g show "refs/tags/$tag:packages/maps/MANIFEST.json" > "$maps"
  g show "refs/tags/$tag:packages/db/src/data-manifest.json" > "$street"
  files="$(node "$root/scripts/publish-assets.ts" check "$slug" "$tag" "$maps" "$street" "$data")" || die "the release data under $data"
  rels="$work/releases.json"
  # The release as GitHub has it now, against the manifests: sets cmp (the lines) and cmp_ok (1 when every asset is right).
  compare() {
    "$GH" api --paginate --slurp "repos/$slug/releases?per_page=100" > "$rels" || die "reading the releases of $slug"
    cmp_ok=1
    cmp="$(node "$root/scripts/publish-assets.ts" compare "$maps" "$street" "$rels" "$tag")" || cmp_ok=0
    [ -n "$cmp" ] || die "the release comparison gave nothing"
  }
  compare
  if [ "$cmp_ok" -eq 1 ] && printf '%s\n' "$cmp" | grep -q -x 'release published'; then
    state_set RELEASE_OK 1
    echo "publish: the release $tag is already published with every asset: nothing to do"
    return 0
  fi
  if printf '%s\n' "$cmp" | grep -q -x 'release published'; then
    printf '%s\n' "$cmp" | grep -v '^ok ' >&2
    die "the release $tag is published and its assets differ; this script never changes a published release"
  fi
  if printf '%s\n' "$cmp" | grep -q '^extra '; then
    printf '%s\n' "$cmp" | grep '^extra ' >&2
    die "the draft release $tag holds files its manifests do not name; remove them by hand"
  fi
  if printf '%s\n' "$cmp" | grep -q -x 'release none'; then
    notes="$work/release-notes.md"
    printf 'Right On Time %s.\n\nThe data files attached here (the map files, the baked tracks, the routing files and the street list) are made from OpenStreetMap data, (c) OpenStreetMap contributors, under the Open Database License 1.0 (see LICENSE-DATA.md). An own copy downloads them as the README says.\n' "$tag" > "$notes"
    "$GH" release create "$tag" --repo "$slug" --verify-tag --draft --title "Right On Time $tag" --notes-file "$notes" || die "creating the draft release"
    compare
  fi
  for x in $(printf '%s\n' "$cmp" | sed -n -e 's/^missing //p' -e 's/^differs \([^ ]*\).*/\1/p'); do
    f="$(printf '%s\n' "$files" | grep -E "/${x//./\\.}\$" | head -1)"
    [ -n "$f" ] || die "no local file for $x"
    if printf '%s\n' "$cmp" | grep -q "^differs $x "; then
      "$GH" release upload "$tag" "$f" --repo "$slug" --clobber || die "uploading $x"
    else
      "$GH" release upload "$tag" "$f" --repo "$slug" || die "uploading $x"
    fi
    echo "publish: uploaded $x"
  done
  compare
  [ "$cmp_ok" -eq 1 ] || { printf '%s\n' "$cmp" | grep -v '^ok ' >&2; die "the draft release $tag is not complete after the uploads"; }
  "$GH" release edit "$tag" --repo "$slug" --draft=false >/dev/null || die "publishing the release"
  compare
  [ "$cmp_ok" -eq 1 ] || die "the published release $tag does not match its manifests"
  printf '%s\n' "$cmp" | grep -q -x 'release published' || die "the release $tag is still a draft"
  state_set RELEASE_OK 1
  echo "publish: released $tag on $slug with $(printf '%s\n' "$cmp" | grep -c '^ok ') assets, each size and sha256 digest checked"
}

# Between releases: PRIVACY.md and SUPPORT.md alone onto the public main (the App Store listing links to them). 1 commit, no tag, no force.
DOCS_FILES=(PRIVACY.md SUPPORT.md)
docs() {
  local priv out list f idx tree base name email when commit blob changed paths
  priv="$(git -C "$root" rev-parse --verify --quiet "$ref^{commit}")" || { echo "publish: no such ref: $ref" >&2; exit 2; }
  out="$work/export"
  list="$work/export.list"
  bash "$root/scripts/publish.sh" --dry-run --ref "$priv" --out "$out" --list "$list" --slug "$slug" || die "the export of $ref did not pass its guards"
  mkdir -p "$work/docs-only"
  for f in "${DOCS_FILES[@]}"; do
    grep -q -x -e "$f" "$list" || die "$f is not in the export of $ref (is it committed, and not on the private paths list?)"
    git -C "$root" show "$priv:$f" > "$work/docs-only/$f" || die "reading $f at $ref"
    cmp -s "$work/docs-only/$f" "$out/$f" || die "$f in the export is not the private file's bytes"
  done
  run_scan "$work/docs-only" || die "the secret scan of the 2 files"
  # F-1714: the files check lists files with git, so the folder is made a repo that holds the private paths list (the export's copy).
  git init --quiet "$work/docs-only"
  mkdir -p "$work/docs-only/scripts"
  git -C "$root" show "$priv:scripts/private-paths.txt" > "$work/docs-only/scripts/private-paths.txt" || die "reading scripts/private-paths.txt at $ref"
  run_docs_files "$work/docs-only" || die "the public files check of the 2 files (ipv4, private-refs, owner-ids)"
  if [ -d "$clone/.git" ]; then
    [ "$(g remote get-url origin)" = "$remote" ] || die "$clone is a clone of $(g remote get-url origin), not $remote"
    g fetch --quiet origin '+refs/heads/*:refs/remotes/origin/*'
  else
    mkdir -p "$(dirname "$clone")"
    git clone --quiet --no-checkout "$remote" "$clone"
  fi
  base="$(g rev-parse --verify --quiet refs/remotes/origin/main)" || die "the public repo has no main branch"
  idx="$work/index"
  rm -f "$idx"
  GIT_INDEX_FILE="$idx" git --git-dir="$clone/.git" read-tree "$base"
  for f in "${DOCS_FILES[@]}"; do
    blob="$(git --git-dir="$clone/.git" hash-object -w "$work/docs-only/$f")"
    GIT_INDEX_FILE="$idx" git --git-dir="$clone/.git" update-index --add --cacheinfo "100644,$blob,$f"
  done
  tree="$(GIT_INDEX_FILE="$idx" git --git-dir="$clone/.git" write-tree)"
  if [ "$tree" = "$(g rev-parse "$base^{tree}")" ]; then
    echo "publish: PRIVACY.md and SUPPORT.md are already on the public main $base: nothing to push"
    return 0
  fi
  # The new tree differs from the public main in the 2 files and nothing else.
  changed="$(g diff-tree -r --no-commit-id --name-only "$base" "$tree" | LC_ALL=C sort | paste -sd ' ' -)"
  paths="$(printf '%s\n' "${DOCS_FILES[@]}" | LC_ALL=C sort | paste -sd ' ' -)"
  for f in $changed; do case " $paths " in *" $f "*) ;; *) die "the commit would change $f: only $paths may change" ;; esac; done
  name="${BW_PUBLISH_NAME:-$(g log -1 --format=%an "$base")}"
  email="${BW_PUBLISH_EMAIL:-$(g log -1 --format=%ae "$base")}"
  when="$(git -C "$root" log -1 --format=%cI "$priv")"
  export GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_AUTHOR_DATE="$when"
  export GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" GIT_COMMITTER_DATE="$when"
  # F-1714: the public message does not name the private commit id (the v1.0.0 commit's message does not either).
  commit="$(printf 'Add the privacy policy and support pages\n\nPRIVACY.md and SUPPORT.md.\n' | g commit-tree --no-gpg-sign -p "$base" "$tree")"
  echo "publish: docs commit $commit (parent $base, the public main) changes: $changed"
  if [ "$dry" -eq 1 ]; then echo "publish: dry run: nothing was pushed. It would run: git -C $clone push origin $commit:refs/heads/main"; return 0; fi
  if [ "$granted" -ne 1 ]; then
    echo "publish: docs writes to the public repo $remote; it runs only with --granted (the owner's grant). It would run:"
    echo "  git -C $clone push origin $commit:refs/heads/main"
    exit 3
  fi
  g push origin "$commit:refs/heads/main" || die "the push"
  [ "$(remote_ref refs/heads/main)" = "$commit" ] || die "after the push the public main is not $commit"
  echo "publish: pushed $commit: PRIVACY.md and SUPPORT.md are on the public main"
}

case "$sub" in
  dry)
    if [ "$dry" -ne 1 ]; then usage; exit 2; fi
    dry_run ;;
  prepare) mkwork; prepare ;;
  image) mkwork; image ;;
  push) mkwork; push ;;
  release) mkwork; release ;;
  docs) mkwork; docs ;;
esac

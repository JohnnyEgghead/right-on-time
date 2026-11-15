#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# why-file: P6-TESTFLIGHT F-988 F-1111 F-1073 (checks a built Release app for the XCUITest rig's seams and for the map glyph and sprite set)
# The release proof of the TestFlight build. Given a built app (RightOnTime.app, or the .xcarchive that holds it), it fails when:
#   1. the JavaScript bundle (main.jsbundle, Hermes bytecode or plain JavaScript) holds a rig seam string: the probe and look launch
#      arguments, the probe's control route, the look reader's JavaScript face, or the Map screen's test read-out (F-988, F-1111, F-1088);
#   2. the app binary holds the look reader's Swift strings (the dictionary keys only BwLookModule.describe writes, F-988), or its Swift
#      symbols (the archive's dSYM is read for them, and its absence is a finding: F-1220);
#   3. map-assets/fonts or map-assets/sprites is missing or empty, a font stack has no 0-255.pbf, or light.json or light.png is missing
#      (F-1073, F-1220: a map with no street, place or water names).
# Usage: check-seams.py <RightOnTime.app | RightOnTime.xcarchive> [--bundle <file>]   (--bundle checks one JavaScript file for the seam strings only)
# Exit 0: clean. Exit 1: at least one finding (each printed). Exit 2: usage, or the app has no bundle or binary to read.
import sys
from pathlib import Path

# Strings the shipped JavaScript must not hold. Each is read only by rig code (src/screens/Probe.tsx, SignInRig.tsx, JobProbe.tsx,
# src/ui/look.ts, boot.ts, NativeMap.tsx, MapTab.tsx), and each is in the rig's bundle (EXPO_PUBLIC_BW_RIG=1).
JS_SEAMS = [
    "bwProbe",           # -bwProbe, -bwProbeJob, -bwProbeControl launch arguments
    "bwLook",            # -bwLook
    "bwMapNames",        # -bwMapNames
    "bwServer",          # -bwServer (the server override a look launch writes)
    "probe/credentials", # the rig's sample sign-in route
    "probe.signin",      # the probe sign-in button
    "readLook",          # the look reader's JavaScript face (modules/bw-look)
    "BwLook",            # the native module's name
    "map.list.focus",    # the Map screen's focus read-out (F-1088)
]
# Strings only the Swift look reader writes (BwLookModule.describe): a release build keeps the module empty (BW_RIG off).
# These are text-only evidence: Swift small strings (15 bytes or fewer) are built from register immediates in -O arm64 code, so a compiled
# reader holds neither as bytes (F-1220 a). They still catch a build that kept the text; the compiled reader is caught by SYMBOLS below.
BINARY_SEAMS = ["uiFamily", "postScript"]
# F-1220 (a): names only the reader's Swift functions carry (BwLookModule.nameRecord, .weightClass). A compiled reader keeps them in the
# symbol and DWARF tables, which the archive's dSYM holds even when the shipped executable is stripped. Measured on the build 2 archive:
# neither is in its dSYM. firstSubview is not here: react-native-screens' RNSScreenView has a variable of that name (a false finding).
SYMBOLS = ["nameRecord", "weightClass"]
# F-1220 (b): the map is drawn with names only when each font stack its layers name has its first glyph range, and the sprite sheet is whole.
# The stacks are the ones apps/web/src/map/assets/fonts holds (ci/native/release-seams.test.ts pins this list to that folder).
FONT_STACKS = ["Noto Sans Italic", "Noto Sans Medium", "Noto Sans Regular"]
SPRITE_FILES = ["light.json", "light.png"]


def app_dir(p: Path) -> Path | None:
    if p.suffix == ".app":
        return p
    found = sorted(p.glob("Products/Applications/*.app"))
    return found[0] if found else None


def contains(path: Path, words: list[str]) -> list[str]:
    data = path.read_bytes()
    return [w for w in words if w.encode() in data]


def dsym_files(archive: Path) -> list[Path]:
    """The DWARF files of an .xcarchive's dSYMs (dSYMs/<name>.app.dSYM/Contents/Resources/DWARF/<name>); [] for an .app or a missing dSYM."""
    return sorted(f for f in archive.glob("dSYMs/*.dSYM/Contents/Resources/DWARF/*") if f.is_file())


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "--bundle":
        hits = contains(Path(argv[2]), JS_SEAMS)
        for h in hits:
            print(f"check-seams: FAIL {argv[2]} holds the rig seam string {h!r}")
        print(f"check-seams: {len(JS_SEAMS)} seam strings looked for in {argv[2]}, {len(hits)} found")
        return 1 if hits else 0
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    app = app_dir(Path(argv[1]))
    if app is None or not app.is_dir():
        print(f"check-seams: no app at {argv[1]}", file=sys.stderr)
        return 2
    bundle = app / "main.jsbundle"
    binary = app / app.stem
    if not bundle.is_file() or not binary.is_file():
        print(f"check-seams: {app} has no main.jsbundle or no {app.stem} executable to read", file=sys.stderr)
        return 2
    findings = 0
    for w in contains(bundle, JS_SEAMS):
        print(f"check-seams: FAIL main.jsbundle holds the rig seam string {w!r} (F-988)")
        findings += 1
    for w in contains(binary, BINARY_SEAMS):
        print(f"check-seams: FAIL the {app.stem} executable holds the look reader string {w!r} (F-988)")
        findings += 1
    # F-1220 (a): the compiled reader's symbols, in the executable's own bytes and in the archive's dSYM. An archive with no dSYM cannot be
    # judged for them (an absent input is not a pass); an .app is never given one, so it says so.
    for w in contains(binary, SYMBOLS):
        print(f"check-seams: FAIL the {app.stem} executable holds the look reader symbol {w!r} (F-1220)")
        findings += 1
    if Path(argv[1]).suffix == ".xcarchive":
        dwarf = dsym_files(Path(argv[1]))
        if not dwarf:
            print(f"check-seams: FAIL {argv[1]} has no dSYM, so the reader's Swift symbols cannot be looked for (F-1220)")
            findings += 1
        for f in dwarf:
            for w in contains(f, SYMBOLS):
                print(f"check-seams: FAIL the dSYM {f.name} holds the look reader symbol {w!r}: the reader is compiled in (F-1220)")
                findings += 1
    else:
        print("check-seams: NOT CHECKED: no dSYM (an .app was given): the compiled reader is looked for in the executable's bytes only; run it on the .xcarchive")
    for sub in ("fonts", "sprites"):
        d = app / "map-assets" / sub
        n = len([f for f in d.iterdir() if not f.name.startswith(".")]) if d.is_dir() else 0
        if n == 0:
            print(f"check-seams: FAIL {app.name}/map-assets/{sub} is missing or empty (F-1073)")
            findings += 1
        else:
            print(f"check-seams: map-assets/{sub}: {n} files")
    # F-1220 (b): a count of files is not the property (a folder holding only a license passes it, and draws no names): each font stack
    # needs its first glyph range, and the sprite sheet its json and png.
    for stack in FONT_STACKS:
        if not (app / "map-assets" / "fonts" / stack / "0-255.pbf").is_file():
            print(f"check-seams: FAIL {app.name}/map-assets/fonts/{stack}/0-255.pbf is missing: that font stack draws no names (F-1220)")
            findings += 1
    for name in SPRITE_FILES:
        if not (app / "map-assets" / "sprites" / name).is_file():
            print(f"check-seams: FAIL {app.name}/map-assets/sprites/{name} is missing: the map draws no icons (F-1220)")
            findings += 1
    print(f"check-seams: {len(JS_SEAMS)} bundle strings, {len(BINARY_SEAMS)} binary strings and {len(SYMBOLS)} symbols looked for, {findings} findings")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

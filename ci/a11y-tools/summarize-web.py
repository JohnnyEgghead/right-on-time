#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# why-file: NFR-06 (P8-A11Y-TOOLS, F-1629: the record is recountable)
# Counts the raw web walk files (web-chromium.json, web-webkit.json, written by ci/a11y-tools/run-web.ts) per check and per screen:
#   python3 ci/a11y-tools/summarize-web.py <dir-with-the-raw-json> [summary-out.json]
# Prints one block per engine: proofs ok, states, errors, and for each check the number of states and of screens with a finding, and the
# screens. The summary file keeps every message of every row (the lane's first summaries kept 1 per screen, so rows could not be re-judged).
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dest = Path(sys.argv[2]) if len(sys.argv) > 2 else src / "summary.json"
summary = {}
for engine in ("chromium", "webkit"):
    f = src / f"web-{engine}.json"
    if not f.exists():
        continue
    raw = json.loads(f.read_text())
    rows = raw["rows"]
    out = {
        "engine": engine,
        "proofs_ok": all(p["ok"] for p in raw["proofs"]),
        "proofs": [f'{p["check"]} {p["page"]} expect {p["expect"]}: {"ok" if p["ok"] else "WRONG"} ({p["got"]})' for p in raw["proofs"]],
        "states": raw["states"],
        "errors": raw["errors"],
        "checks": {},
    }
    for check in ("reflow", "text", "motion"):
        hit = [r for r in rows if r[check]]
        screens = sorted({r["screen"] for r in hit})
        out["checks"][check] = {
            "states_with_findings": len(hit),
            "screens_with_findings": len(screens),
            "screens": screens,
            "by_screen": {s: [{"path": r["path"], "messages": r[check]} for r in hit if r["screen"] == s] for s in screens},
        }
    summary[engine] = out
    print(f'{engine}: proofs {"ok" if out["proofs_ok"] else "WRONG"}, {out["states"]} states, {out["errors"]} errors')
    for check, c in out["checks"].items():
        print(f'  {check}: {c["states_with_findings"]} states, {c["screens_with_findings"]} screens')
    print("  text screens: " + " ".join(out["checks"]["text"]["screens"]))
both = {e: set(summary[e]["checks"]["text"]["screens"]) for e in summary}
if len(both) == 2:
    print("text screens only on chromium: " + " ".join(sorted(both["chromium"] - both["webkit"])))
    print("text screens only on webkit: " + " ".join(sorted(both["webkit"] - both["chromium"])))
dest.write_text(json.dumps(summary, indent=1) + "\n")
print(f"wrote {dest}")

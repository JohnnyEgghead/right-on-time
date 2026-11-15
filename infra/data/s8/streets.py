# SPDX-License-Identifier: AGPL-3.0-or-later
"""Street-name source for SD-23: named drivable ways inside the 3 branch bboxes.
One row per (branch, street name); 1 to 8 on-street points. Output: /d/out/streets.json
City/ZIP are NOT in this source (OSM ways rarely carry addr:*); see the S8 record.
"""
import json, os, sys
import osmium

# The one box table (F-15): infra/data/s8/boxes.json, mounted by run.sh at /boxes.json (BW_BOXES overrides the path).
BOX = {b: tuple(v) for b, v in json.load(open(os.environ.get("BW_BOXES", "/boxes.json")))["boxes"].items()}  # lon_min, lat_min, lon_max, lat_max
HW = {"residential", "tertiary", "secondary", "primary", "unclassified", "living_street",
      "tertiary_link", "secondary_link", "primary_link", "trunk", "trunk_link"}

streets = {}  # (branch, name) -> list of (lon, lat)


class H(osmium.SimpleHandler):
    def way(self, w):
        hw = w.tags.get("highway")
        name = w.tags.get("name")
        if hw not in HW or not name:
            return
        pts = []
        for n in w.nodes:
            if n.location.valid():
                pts.append((n.lon, n.lat))
        if not pts:
            return
        mid = pts[len(pts) // 2]
        for b, (x0, y0, x1, y1) in BOX.items():
            if x0 <= mid[0] <= x1 and y0 <= mid[1] <= y1:
                streets.setdefault((b, name), []).append(mid)
                break


H().apply_file("/d/ohio.osm.pbf", locations=True)
rows = []
for (b, name), mids in sorted(streets.items()):
    mids.sort()
    k = min(8, len(mids))
    idx = sorted({round(i * (len(mids) - 1) / max(1, k - 1)) for i in range(k)})
    pts = [[round(mids[i][0], 6), round(mids[i][1], 6)] for i in idx]
    rows.append({"branch": b, "name": name, "points": pts})
os.makedirs("/d/out", exist_ok=True)
with open("/d/out/streets.json", "w") as f:
    json.dump(rows, f, separators=(",", ":"), ensure_ascii=False)
from collections import Counter
print(Counter(r["branch"] for r in rows), len(rows))

# SPDX-License-Identifier: AGPL-3.0-or-later
"""Bounded van-track bake model for S8 (FR-MAP-5). Output: /d/out/tracks.ndjson
The seeded schedule does not exist yet, so stops are drawn (seed 8) from street-list points.
Model, from the documents where they give a number (the S8 record, "Tracks", lists each source):
  Sep 15 technicians and jobs: Columbus 12 and 52 (UI-SPECIFICATION lines 836 and 1618); 31
  technicians in all (STORY-ADDITIONS line 212). ASSUMPTION: no document splits the other 19, so
  Dayton 11 and Springfield 8. ASSUMPTION: Dayton and Springfield get Columbus's ratio of jobs per
  technician (52/12), rounded: 48 and 35 jobs.
  Every demo-week day (Mon Sep 14 to Fri Sep 18, 2026) carries the Sep 15 load (assumption).
  4 dated clock presets (SPECIFICATIONS line 1143): Sat Oct 31, Sun Nov 1, Sat Mar 13 2027, Sun Mar 14 2027;
  ASSUMPTION: each has jobs, at the full weekday load (an upper bound).
  Per technician-day: legs = depot->j1, j1->j2 ... j(k-1)->jk, jk->depot (k+1 legs for k jobs).
  Sep 15 pair set: all ordered same-branch job pairs, n*(n-1) per branch.
"""
import json, random, urllib.request, sys, os, itertools

OSRM = "http://bw-osrm:5000"
BUILD_ID = "ohio-261001+osrm-v26.10.0"
TECHS = {"columbus": 12, "dayton": 11, "springfield": 8}
JOBS = {"columbus": 52, "dayton": 48, "springfield": 35}
DEMO_DAYS = 5
PRESET_DAYS = 4
rnd = random.Random(8)
streets = json.load(open("/d/out/streets.json"))
by = {}
for s in streets:
    by.setdefault(s["branch"], []).append(s)


def pick(branch):
    s = rnd.choice(by[branch])
    p = rnd.choice(s["points"])
    return (p[0], p[1])


def enc1(v):
    v = ~(v << 1) if v < 0 else (v << 1)
    out = ""
    while v >= 0x20:
        out += chr((0x20 | (v & 0x1F)) + 63)
        v >>= 5
    return out + chr(v + 63)


def enc(coords):
    plat = plon = 0
    out = ""
    for lon, lat in coords:
        la, lo = round(lat * 1e5), round(lon * 1e5)
        out += enc1(la - plat) + enc1(lo - plon)
        plat, plon = la, lo
    return out


def route(a, b):
    url = f"{OSRM}/route/v1/driving/{a[0]},{a[1]};{b[0]},{b[1]}?overview=full&geometries=geojson&annotations=duration"
    with urllib.request.urlopen(url, timeout=60) as r:
        d = json.load(r)
    if d.get("code") != "Ok":
        return None
    rt = d["routes"][0]
    coords = rt["geometry"]["coordinates"]
    durs = rt["legs"][0]["annotation"]["duration"]
    cum = [0.0]
    for x in durs:
        cum.append(cum[-1] + x)
    if len(cum) != len(coords):  # keep one second value per vertex
        n = len(coords)
        cum = [rt["duration"] * i / (n - 1) for i in range(n)] if n > 1 else [0]
    return enc(coords), [round(c) for c in cum], round(rt["distance"])


legs = []  # (branch, from_ref, to_ref, a, b)
n = 0
def add(branch, fr, to, a, b):
    legs.append((branch, fr, to, a, b))

# demo week (5 days) + 4 preset days: per technician-day = depot, k jobs, depot
for branch, techs in TECHS.items():
    depot = pick(branch)
    for day in range(DEMO_DAYS + PRESET_DAYS):
        for t in range(techs):
            k = JOBS[branch] // techs + (1 if t < JOBS[branch] % techs else 0)
            refs = ["depot"] + [f"{branch[:2]}-d{day}-t{t}-j{i}" for i in range(k)] + ["depot"]
            pts = [depot] + [pick(branch) for _ in range(k)] + [depot]
            for i in range(len(pts) - 1):
                add(branch, refs[i], refs[i + 1], pts[i], pts[i + 1])
    # Sep 15: all ordered same-branch pairs of that day's jobs
    jobs = [pick(branch) for _ in range(JOBS[branch])]
    for i, j in itertools.permutations(range(len(jobs)), 2):
        add(branch, f"{branch[:2]}-s15-{i}", f"{branch[:2]}-s15-{j}", jobs[i], jobs[j])

ok = fail = 0
with open("/d/out/tracks.ndjson", "w") as f:
    for k, (branch, fr, to, a, b) in enumerate(legs):
        r = route(a, b)
        if r is None:
            fail += 1
            continue
        poly, secs, dist = r
        f.write(json.dumps({"id": k, "branch_id": branch, "from_ref": fr, "to_ref": to,
                            "polyline": poly, "seconds": secs, "distance_m": dist,
                            "build_id": BUILD_ID}, separators=(",", ":")) + "\n")
        ok += 1
print("legs", len(legs), "ok", ok, "fail", fail)

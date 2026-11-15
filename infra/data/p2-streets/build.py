# SPDX-License-Identifier: AGPL-3.0-or-later
"""P2-STREETS: cut the bundled street list (SPECIFICATIONS SD-23) from the S8 street source plus Census boundary files.

Usage: python -I build.py <record.md> <in-dir> <out-dir>
  record.md  docs/build/spikes/P2-STREETS.md: the input table in it holds the SHA-256 every input must match.
  in-dir     holds streets.json, tl_2024_us_zcta520.zip, tl_2024_39_place.zip, tl_2024_39_cousub.zip.
  out-dir    receives street-list.json, street-list.stats.json, census-names.json and tiebreak-points.json.

Refuses (exit 2, writes nothing) unless EVERY input's SHA-256 equals the value in the record's input table.
Needs pyshp, shapely and pyproj (run.sh installs pinned versions in a container).

Rules (owner rulings: dashboard question 07fc3d14, Nov 1, 2026, "Census files + spike boxes"; question c19c29b6,
Nov 1, 2026, "Nearest town"):
- Branch areas are the 3 rectangles of infra/data/s8/boxes.json, the one box table (F-15). A point outside every box is dropped.
- ZIP = the ZCTA5 polygon holding the point (boundary counts as inside). A point in no ZCTA is dropped (counted, never guessed).
- City = the Census place holding the point (NAME). A point in no place takes the NEAREST Census place of the same place file:
  the distance from the point to each place polygon in meters in UTM 17N (EPSG:32617); a tie (equal to the millimeter)
  goes to the name that sorts first. No row carries a county subdivision (township) label.
- Edge tie-break (F-173): a point on the edge of 2 or more ZCTAs (or places) takes the ZIP (or city) held by the most OTHER points
  of the same source street (same branch and name) that are not themselves on an edge; a tie of counts, or a street with no such point,
  goes to the lowest ZIP code (or the first name). It never depends on the order of the shapefile.
- 1 output row per (branch, street name, city, ZIP); a street over 2 ZIP codes becomes 2 rows, each with its own points.
- No house-number field exists in the source or the output.
"""
import hashlib
import json
import os
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path

INPUTS = ["streets.json", "tl_2024_us_zcta520.zip", "tl_2024_39_place.zip", "tl_2024_39_cousub.zip"]
BOXES = Path(os.environ.get("BW_BOXES", Path(__file__).resolve().parent.parent / "s8" / "boxes.json"))
BOX = {b: tuple(v) for b, v in json.loads(BOXES.read_text(encoding="utf-8"))["boxes"].items()}  # lon_min, lat_min, lon_max, lat_max (order = tie-break)
MAX_POINTS = 8
UTM = "EPSG:32617"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pinned(record):
    """name -> sha256 from the record's input table rows: | `name` | bytes | sha256 |"""
    out = {}
    for line in Path(record).read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\|\s*`([^`]+)`\s*\|[^|]*\|\s*([0-9a-f]{64})\s*\|", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def check_inputs(record, indir):
    want = pinned(record)
    bad = []
    for name in INPUTS:
        p = Path(indir) / name
        if name not in want:
            bad.append(f"{name}: no pinned SHA-256 in {record}")
        elif not p.is_file():
            bad.append(f"{name}: missing in {indir}")
        else:
            got = sha256(p)
            if got != want[name]:
                bad.append(f"{name}: SHA-256 {got} does not match the pinned {want[name]}")
    if bad:
        print("REFUSED: input check failed", *bad, sep="\n  ", file=sys.stderr)
        sys.exit(2)
    print("inputs verified:", ", ".join(INPUTS))


def read_zip_shapes(zpath, keep_box, fields):
    """Yield (shapely geometry, {field: value}) for shapefile records whose bbox meets keep_box."""
    import shapefile
    from shapely.geometry import shape, box
    kb = box(*keep_box)
    with zipfile.ZipFile(zpath) as z:
        stem = next(n[:-4] for n in z.namelist() if n.endswith(".shp"))
        with z.open(stem + ".shp") as shp, z.open(stem + ".dbf") as dbf, z.open(stem + ".shx") as shx:
            r = shapefile.Reader(shp=shp, dbf=dbf, shx=shx, encoding="utf-8")
            names = [f[0] for f in r.fields[1:]]
            for sr in r.iterShapeRecords():
                s = sr.shape
                if not s.points:
                    continue
                x0, y0, x1, y1 = s.bbox
                if x1 < keep_box[0] or x0 > keep_box[2] or y1 < keep_box[1] or y0 > keep_box[3]:
                    continue
                g = shape(s.__geo_interface__)
                if not g.intersects(kb):
                    continue
                rec = dict(zip(names, sr.record))
                yield g, {k: rec[k] for k in fields}


def lookup(geoms_attrs):
    """at(lon, lat) -> (attrs of EVERY shape that touches the point, in file order; attrs of the shapes that hold it strictly inside)."""
    from shapely import STRtree
    from shapely.geometry import Point
    geoms = [g for g, _ in geoms_attrs]
    attrs = [a for _, a in geoms_attrs]
    tree = STRtree(geoms)

    def at(lon, lat):
        p = Point(lon, lat)
        touching = sorted(int(i) for i in tree.query(p, predicate="intersects"))
        inside = {int(i) for i in tree.query(p, predicate="within")}
        return [attrs[i] for i in touching], [attrs[i] for i in touching if i in inside]
    return at


def nearest_place_fn(places):
    """nearest(lon, lat) -> (place NAME, distance in meters): the closest place polygon in UTM 17N; a tie to the millimeter goes to the first name."""
    from pyproj import Transformer
    from shapely import STRtree
    from shapely.geometry import Point
    from shapely.ops import transform
    to_utm = Transformer.from_crs("EPSG:4326", UTM, always_xy=True).transform
    geoms = [transform(to_utm, g) for g, _ in places]
    names = [a["NAME"] for _, a in places]
    tree = STRtree(geoms)

    def nearest(lon, lat):
        x, y = to_utm(lon, lat)
        idx, dist = tree.query_nearest(Point(x, y), all_matches=True, return_distance=True)
        best = min((round(float(d), 3), names[int(i)]) for i, d in zip(idx, dist))
        return best[1], best[0]
    return nearest


def pick(cands, tally):
    """The candidate held by the most other points of the street; a tie of counts goes to the smallest value. -> (value, basis)."""
    best = min(cands, key=lambda c: (-tally[c], c))
    return best, ("street" if tally[best] > 0 else "lowest")


def main():
    record, indir, outdir = sys.argv[1:4]
    check_inputs(record, indir)
    indir, outdir = Path(indir), Path(outdir)
    union = (min(b[0] for b in BOX.values()), min(b[1] for b in BOX.values()),
             max(b[2] for b in BOX.values()), max(b[3] for b in BOX.values()))
    zip_at = lookup(list(read_zip_shapes(indir / "tl_2024_us_zcta520.zip", union, ["ZCTA5CE20"])))
    ohio = (-180.0, -90.0, 180.0, 90.0)  # the whole place file: the nearest place of a point at a box edge may lie outside the boxes
    places = list(read_zip_shapes(indir / "tl_2024_39_place.zip", ohio, ["NAME"]))
    place_at = lookup(places)
    nearest_place = nearest_place_fn(places)
    place_names = sorted({a["NAME"] for _, a in places})
    subs = list(read_zip_shapes(indir / "tl_2024_39_cousub.zip", ohio, ["NAME", "NAMELSAD"]))
    sub_names = sorted({a["NAME"] for _, a in subs} | {a["NAMELSAD"] for _, a in subs})

    src = json.loads((indir / "streets.json").read_text(encoding="utf-8"))
    st = Counter()
    st["source_rows"] = len(src)
    rows = {}      # (branch, name, city, zip) -> {"points": [...], "strict_zip": bool, "nearest": bool}
    tied = []      # every point that took an edge tie-break
    max_nearest_m = 0.0
    for r in src:
        pts = []
        for lon, lat in r["points"]:
            st["source_points"] += 1
            branch = next((b for b, (x0, y0, x1, y1) in BOX.items() if x0 <= lon <= x1 and y0 <= lat <= y1), None)
            if branch is None:
                st["dropped_outside_boxes"] += 1
                continue
            zt, zs = zip_at(lon, lat)
            if not zt:
                st["dropped_no_zip"] += 1
                continue
            pt, _ = place_at(lon, lat)
            nearest = False
            if pt:
                cities = sorted({a["NAME"] for a in pt})
            else:
                name, m = nearest_place(lon, lat)
                cities, nearest = [name], True
                max_nearest_m = max(max_nearest_m, m)
            pts.append({"lon": lon, "lat": lat, "branch": branch, "zips": sorted({a["ZCTA5CE20"] for a in zt}),
                        "strict": {a["ZCTA5CE20"] for a in zs}, "cities": cities, "nearest": nearest})
        # the street's other points that sit on no edge vote for the ZIP and the city of the points that do
        zt_tally = Counter(p["zips"][0] for p in pts if len(p["zips"]) == 1)
        ct_tally = Counter(p["cities"][0] for p in pts if len(p["cities"]) == 1)
        for p in pts:
            if len(p["zips"]) > 1:
                z, zb = pick(p["zips"], zt_tally)
                st["zip_edge_points"] += 1
                st["zip_edge_points_" + ("by_street" if zb == "street" else "lowest_code")] += 1
            else:
                z, zb = p["zips"][0], None
                if z not in p["strict"]:
                    st["zip_single_zcta_edge_points"] += 1
            if len(p["cities"]) > 1:
                c, cb = pick(p["cities"], ct_tally)
                st["city_edge_points"] += 1
                st["city_edge_points_" + ("by_street" if cb == "street" else "first_name")] += 1
            else:
                c, cb = p["cities"][0], None
            if p["nearest"]:
                st["points_nearest_place"] += 1
            else:
                st["points_in_place"] += 1
            if zb or cb:
                tied.append({"branch": p["branch"], "name": r["name"], "point": [p["lon"], p["lat"]], "zip": z, "city": c,
                             "zip_basis": zb, "city_basis": cb})
            v = rows.setdefault((p["branch"], r["name"], c, z), {"points": [], "strict_zip": False, "nearest": False})
            pt_ = [p["lon"], p["lat"]]
            if pt_ not in v["points"]:
                v["points"].append(pt_)
            v["strict_zip"] = v["strict_zip"] or z in p["strict"]
            v["nearest"] = v["nearest"] or p["nearest"]
            st["kept_points"] += 1
    out = []
    names = set(place_names)
    for (branch, name, city, zipc), v in sorted(rows.items()):
        pts = sorted(v["points"])
        assert 1 <= len(pts) <= MAX_POINTS, (branch, name, len(pts))
        assert city in names, (branch, name, city)  # every city is a Census place name; no township label survives
        out.append({"branch": branch, "name": name, "city": city, "zip": zipc, "points": pts})
        st["rows_branch_" + branch] += 1
        st["rows_with_nearest_town_point"] += v["nearest"]
        st["rows_no_point_strictly_inside_own_zip"] += (not v["strict_zip"])
    per_src = Counter((k[0], k[1]) for k in rows)
    st["rows_total"] = len(out)
    st["source_streets_split_into_2_plus_rows"] = sum(1 for n in per_src.values() if n > 1)
    st["rows_from_split_streets"] = sum(n for n in per_src.values() if n > 1)
    st["max_nearest_town_distance_m"] = round(max_nearest_m, 1)
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "street-list.json").write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    (outdir / "street-list.stats.json").write_text(json.dumps(dict(sorted(st.items())), indent=2) + "\n", encoding="utf-8")
    tied.sort(key=lambda t: (t["branch"], t["name"], t["point"]))
    (outdir / "tiebreak-points.json").write_text(json.dumps(tied, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    (outdir / "census-names.json").write_text(json.dumps({"places": place_names, "subdivisions": sub_names}, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(dict(sorted(st.items())), indent=2))


if __name__ == "__main__":
    main()

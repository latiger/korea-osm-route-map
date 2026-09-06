#!/usr/bin/env python3
"""Convert MOLIT 일반국도 도로중심선 SHP → public/data/national-roads/*.json

Usage:
  python3 scripts/process_molit_national_roads.py \
    [--shp data/raw/molit_shp/국도중심선_2025-08.shp]

Requires: gdal (python3-gdal / ogr2ogr).
Raw ZIP/SHP should stay gitignored; only processed public JSON is committed.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

from osgeo import ogr

ogr.UseExceptions()

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SHP = ROOT / "data/raw/molit_shp/국도중심선_2025-08.shp"
OUT_DIR = ROOT / "public/data/national-roads"
PROC = ROOT / "data/processed/national-roads"
SIMPLIFY_TOL = 0.00035
MAX_DISPLAY_PTS = 800


def haversine(a, b):
    R = 6371000.0
    lat1, lon1 = math.radians(a[1]), math.radians(a[0])
    lat2, lon2 = math.radians(b[1]), math.radians(b[0])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * R * math.asin(math.sqrt(h))


def geom_to_coords(geom):
    if geom is None:
        return []
    gtype = geom.GetGeometryName()
    if gtype == "LINESTRING":
        return [[[geom.GetX(i), geom.GetY(i)] for i in range(geom.GetPointCount())]]
    if gtype in ("MULTILINESTRING", "GEOMETRYCOLLECTION"):
        lines = []
        for i in range(geom.GetGeometryCount()):
            lines.extend(geom_to_coords(geom.GetGeometryRef(i)))
        return lines
    return []


def farthest_endpoints(lines):
    endpoints = []
    for line in lines:
        if len(line) >= 2:
            endpoints.append(line[0])
            endpoints.append(line[-1])
    if len(endpoints) < 2:
        p = endpoints[0] if endpoints else [0, 0]
        return p, p
    best_i, best_j, best_d = 0, 1, -1.0
    for i in range(len(endpoints)):
        for j in range(i + 1, len(endpoints)):
            d = haversine(endpoints[i], endpoints[j])
            if d > best_d:
                best_i, best_j, best_d = i, j, d
    return endpoints[best_i], endpoints[best_j]


def downsample(coords, max_pts):
    if len(coords) <= max_pts:
        return coords
    step = (len(coords) - 1) / (max_pts - 1)
    out = [coords[int(round(i * step))] for i in range(max_pts)]
    out[-1] = coords[-1]
    return out


def merge_connected(lines):
    remaining = [list(l) for l in lines if len(l) >= 2]
    chains = []

    def near(p, q):
        return abs(p[0] - q[0]) < 0.0003 and abs(p[1] - q[1]) < 0.0003

    while remaining:
        chain = remaining.pop()
        changed = True
        while changed:
            changed = False
            for i, other in enumerate(remaining):
                a0, a1 = chain[0], chain[-1]
                b0, b1 = other[0], other[-1]
                if near(a1, b0):
                    chain = chain + other[1:]
                    remaining.pop(i)
                    changed = True
                    break
                if near(a1, b1):
                    chain = chain + list(reversed(other))[1:]
                    remaining.pop(i)
                    changed = True
                    break
                if near(a0, b1):
                    chain = other[:-1] + chain
                    remaining.pop(i)
                    changed = True
                    break
                if near(a0, b0):
                    chain = list(reversed(other))[:-1] + chain
                    remaining.pop(i)
                    changed = True
                    break
        chains.append(chain)
    return chains


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shp", type=Path, default=DEFAULT_SHP)
    args = ap.parse_args()
    shp = args.shp
    if not shp.exists():
        raise SystemExit(f"SHP not found: {shp}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    PROC.mkdir(parents=True, exist_ok=True)

    ds = ogr.Open(str(shp))
    ly = ds.GetLayer(0)
    by_route = defaultdict(list)
    for f in ly:
        route = (f.GetField("노선번호") or "").strip()
        if not route:
            continue
        length = f.GetField("영역길이") or 0
        agency = f.GetField("관리기관")
        g = f.GetGeometryRef()
        if g is None:
            continue
        g2 = g.Clone()
        g2.SimplifyPreserveTopology(SIMPLIFY_TOL)
        by_route[route].append((float(length), g2.ExportToWkb(), agency))

    index = {
        "source": "MOLIT 일반국도 도로중심선 (data.go.kr 15122482)",
        "updated": "2025-08",
        "crs": "EPSG:4326",
        "routes": {},
    }
    all_features = []

    for route in sorted(by_route.keys(), key=lambda x: int(x) if x.isdigit() else x):
        segs = by_route[route]
        total_len = sum(s[0] for s in segs)
        agencies = sorted({s[2] for s in segs if s[2]})
        lines = []
        for _length, wkb, _agency in segs:
            g = ogr.CreateGeometryFromWkb(wkb)
            lines.extend(geom_to_coords(g))
        chains = merge_connected(lines)
        chains.sort(key=len, reverse=True)
        display_lines = []
        for ch in chains:
            cap = (
                MAX_DISPLAY_PTS
                if len(chains) == 1
                else max(120, MAX_DISPLAY_PTS // max(1, len(chains)))
            )
            display_lines.append(downsample(ch, cap))
        start, end = farthest_endpoints(display_lines)
        xs = [p[0] for line in display_lines for p in line]
        ys = [p[1] for line in display_lines for p in line]
        bbox = [min(xs), min(ys), max(xs), max(ys)] if xs else [0, 0, 0, 0]
        route_no_norm = str(int(route)) if route.isdigit() else route
        name = f"국도 제{route_no_norm}호선"
        route_obj = {
            "routeNo": route_no_norm,
            "routeNoRaw": route,
            "name": name,
            "aliases": [
                f"{route_no_norm}번국도",
                f"국도{route_no_norm}",
                f"국도{route_no_norm}호선",
                f"국도 제{route_no_norm}호선",
                name,
            ],
            "bbox": bbox,
            "start": {"lng": start[0], "lat": start[1]},
            "end": {"lng": end[0], "lat": end[1]},
            "lengthMetersApprox": round(total_len),
            "segmentCount": len(segs),
            "agencies": agencies,
            "lineCount": len(display_lines),
        }
        geom_payload = {
            "type": "MultiLineString" if len(display_lines) > 1 else "LineString",
            "coordinates": display_lines
            if len(display_lines) > 1
            else (display_lines[0] if display_lines else []),
        }
        flat = []
        for line in display_lines:
            flat.extend({"lat": p[1], "lng": p[0]} for p in line)
        route_file = {**route_obj, "geometry": geom_payload, "coordinates": flat}
        (OUT_DIR / f"{route_no_norm}.json").write_text(
            json.dumps(route_file, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        sample = []
        if display_lines:
            longest = max(display_lines, key=len)
            sample = downsample(longest, 40)
        index["routes"][route_no_norm] = {
            **route_obj,
            "sampleLine": sample,
            "file": f"{route_no_norm}.json",
        }
        all_features.append(
            {
                "type": "Feature",
                "properties": {
                    k: route_obj[k]
                    for k in ("routeNo", "name", "lengthMetersApprox", "segmentCount")
                },
                "geometry": geom_payload,
            }
        )
        print(
            f"route {route_no_norm}: segs={len(segs)} lines={len(display_lines)} "
            f"pts={sum(len(l) for l in display_lines)} len_km={total_len/1000:.1f}"
        )

    (OUT_DIR / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    (PROC / "national_roads_simplified.geojson").write_text(
        json.dumps(
            {"type": "FeatureCollection", "features": all_features},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"Wrote {len(index['routes'])} routes → {OUT_DIR}")


if __name__ == "__main__":
    main()

"""Refresh static/routes.json from the official EMT Valencia GTFS feed (CC BY 4.0).

Output per line: {"ida": {"shapes": [polylines], "stops": [ordered ids]},
                  "vuelta": {...}}  — directions paired by reversed termini,
                  ida = the (a, b) group with a < b. Itinerary stop ids match
                  the live API's pUlt/pSig values.

Source: https://opendata.vlci.valencia.es/dataset/google-transit-lines-stops-bus-schedules
"""
import csv
import io
import json
import urllib.request
import zipfile

GTFS_URL = ("https://opendata.vlci.valencia.es/dataset/ab058cf8-ad3e-4d9c-ac89-0c6367ecf351/"
            "resource/c81b69e6-c082-44dc-acc6-66fc417b4e66/download/google_transit2026-09-27.zip")

with zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(GTFS_URL, timeout=120).read())) as z:
    def rows(name):
        return csv.DictReader(io.StringIO(z.read(name).decode("utf-8")))

    line_of_route = {r["route_id"]: r["route_short_name"] for r in rows("routes.txt")}

    rep_trip = {}  # shape_id -> one trip_id
    shapes_of_line = {}
    for t in rows("trips.txt"):
        sid = t.get("shape_id")
        if not sid:
            continue
        shapes_of_line.setdefault(line_of_route[t["route_id"]], set()).add(sid)
        rep_trip.setdefault(sid, t["trip_id"])

    seq = {}  # trip_id -> [(stop_sequence, stop_id)]
    for s in rows("stop_times.txt"):
        if s["trip_id"] in rep_trip.values():
            seq.setdefault(s["trip_id"], []).append((int(s["stop_sequence"]), s["stop_id"]))

    points = {}  # shape_id -> [[lat, lon], ...]
    for p in rows("shapes.txt"):
        points.setdefault(p["shape_id"], []).append(
            [round(float(p["shape_pt_lat"]), 5), round(float(p["shape_pt_lon"]), 5)])

routes = {}
for line, sids in shapes_of_line.items():
    groups = {}  # (first_stop, last_stop) -> {"shapes": [...], "stops": [...]}
    for sid in sids:
        if sid not in points or sid not in rep_trip:
            continue
        ordered = [x[1] for x in sorted(seq.get(rep_trip[sid], []))]
        if len(ordered) < 2:
            continue
        key = (ordered[0], ordered[-1])
        g = groups.setdefault(key, {"shapes": [], "stops": []})
        g["shapes"].append(points[sid])
        if len(ordered) > len(g["stops"]):
            g["stops"] = ordered

    ida, vuelta = {"shapes": [], "stops": []}, {"shapes": [], "stops": []}
    for (a, b), g in groups.items():
        side = ida if (a < b or (b, a) not in groups) else vuelta
        side["shapes"] += g["shapes"]
        if len(g["stops"]) > len(side["stops"]):
            side["stops"] = g["stops"]
    if ida["shapes"]:
        routes[line] = {"ida": ida, "vuelta": vuelta}

assert routes and routes["19"]["ida"]["stops"] and routes["19"]["vuelta"]["stops"]
with open("static/routes.json", "w") as fh:
    json.dump(routes, fh, ensure_ascii=False, separators=(",", ":"))
print(f"saved {len(routes)} lines; 19 ida stops: {len(routes['19']['ida']['stops'])}, "
      f"vuelta: {len(routes['19']['vuelta']['stops'])}")

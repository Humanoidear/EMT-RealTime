"""Refresh static/stops.json from the Valencia open data Geoportal (CC BY 4.0).

Source: https://opendata.vlci.valencia.es/dataset/emt
MapServer: https://geoportal.valencia.es/server/rest/services/OPENDATA/Trafico/MapServer/226
"""
import json

import requests

U = "https://geoportal.valencia.es/server/rest/services/OPENDATA/Trafico/MapServer/226/query"

stops, offset = [], 0
while True:
    r = requests.get(U, params={"where": "suprimida=0", "outFields": "id_parada,denominacion,lineas",
                                "f": "json", "outSR": "4326", "resultOffset": offset,
                                "resultRecordCount": 2000, "orderByFields": "id_parada"}, timeout=30).json()
    feats = r.get("features", [])
    if not feats:
        break
    for f in feats:
        a, g = f["attributes"], f["geometry"]
        stops.append({"id": a["id_parada"], "nombre": a["denominacion"].strip(),
                      "lineas": [x for x in a["lineas"].split(",") if x.strip()],
                      "lat": g["y"], "lon": g["x"]})
    offset += len(feats)
    if r.get("exceededTransferLimit") is not True:
        break

stops.sort(key=lambda s: s["id"])
assert stops and all("lat" in s for s in stops)
with open("static/stops.json", "w") as fh:
    json.dump(stops, fh, ensure_ascii=False, separators=(",", ":"))
print(f"saved {len(stops)} stops")

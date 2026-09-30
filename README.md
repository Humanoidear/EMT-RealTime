# EMT-RealTime

Live EMT Valencia bus map — Flask + MapLibre GL (dark 3D vector basemap from
CARTO), shadcn-style components in plain HTML/CSS. Routes drawn as
**ida (blue) / vuelta (red)** from the official GTFS feed; bus markers use
route-constrained dead reckoning — each one advances along its GTFS polyline at
its measured speed (verified: live fixes sit 0–24 m from the shape) and is eased
back onto track when a real fix arrives, so it follows the roads, never freezes
mid-road and never snaps. A bus projected within 35 m of its next stop is assumed
to be serving it and is pinned there until the API shows it leaving (30 m of
hysteresis). Repeated identical fixes are ignored. Click a stop for a menu of arrivals
(all lines serving it) and the map reveals the closest approaching buses; click
a bus to **follow it** (camera tracks it, panel shows time to the next stop and
every stop ahead). The **3D view** button tilts the map and shows extruded
buildings (light/dark theme toggle, CARTO Dark Matter / Positron; the choice is
remembered). The sidebar holds two collapsible cards: **stops near you**
(locate yourself or search stops by name / number) and **favorites** (star a
stop; kept in localStorage). Every stop in the network is plotted on the map;
click one and its arrivals open in a bottom-right panel. **Tap a line there to
reveal it** — its route and live buses appear, a tracking chip shows over the
map, and tapping it again (or picking another line) stops it and unfollows any
bus. Service incidents scraped from EMT's "estado del servicio" page are shown
next to each affected line. ETAs come from the EMT estimaciones API when the WSSE token is fresh,
otherwise computed from live positions (~18 km/h avg).

## Run

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Set `CARTO_API_KEY` in the environment or `.env` (gitignored) — it's appended to
every `basemaps.cartocdn.com` request (style, tiles, glyphs, sprites).

Open http://127.0.0.1:8000 — pick a bus line to track live positions, or check ETAs for a stop.

Note: the "use my location" button needs a secure context, so it works on
`http://127.0.0.1:8000` (or HTTPS) but not over a plain LAN IP.

## Bus stops

`static/stops.json` is baked from the Valencia open data portal (CC BY 4.0):
<https://opendata.vlci.valencia.es/dataset/emt>. Stops for the tracked line are
shown as dots — click one to load its ETAs. Refresh with:

```sh
.venv/bin/python fetch_stops.py
```

`static/routes.json` (per-line route polylines) is baked from the official EMT
GTFS feed (Google Transit, CC BY 4.0). Refresh with:

```sh
.venv/bin/python fetch_routes.py
```

## Direct API curls

```sh
# bus positions for a line
curl --compressed 'https://servicios.emtvalencia.es/buses/linea.php?usuario=7gH8m45w7A&linea=19' \
  -H 'Accept-Charset: UTF-8' \
  -H 'Content-Type: application/json; charset=UTF-8' \
  -H 'User-Agent: Dalvik/2.1.0 (Linux; U; Android 17; Pixel 8a Build/CP41.260831.007)' \
  -H 'X-WSSE: UsernameToken Username="7gH8m45w7A", PasswordDigest="ODdmMzU1OWU4ZDEwZGE0MDllM2E5NzhlZTg3Y2UxMmRjYTQ2N2VmYQ==", Nonce="MjZlNTNjMWIxZmZhMmU4NjE5N2QyYjhkMjgyMGU2YjU=", Created="1790762921"'

# arrivals for a stop
curl --compressed 'https://servicios.emtvalencia.es/estimaciones/estimacion.php?idioma=en&parada=25&adaptados=false' \
  -H 'Accept-Charset: UTF-8' \
  -H 'Content-Type: application/json; charset=UTF-8' \
  -H 'User-Agent: Dalvik/2.1.0 (Linux; U; Android 17; Pixel 8a Build/CP41.260831.007)' \
  -H 'X-WSSE: UsernameToken Username="7gH8m45w7A", PasswordDigest="ODdmMzU1OWU4ZDEwZGE0MDllM2E5NzhlZTg3Y2UxMmRjYTQ2N2VmYQ==", Nonce="MjZlNTNjMWIxZmZhMmU4NjE5N2QyYjhkMjgyMGU2YjU=", Created="1790762921"'
```

Note: `buses/linea.php` works with the replayed token (verified live).
`estimaciones` authenticates it but returns **empty data** for stale/replayed
tokens — minting fresh ones needs the app's secret password (never sent over
the wire, extractable from the EMT APK):
`PasswordDigest = base64(sha1(nonce + created + password))`.

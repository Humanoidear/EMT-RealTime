import json
import math
import os
import re
import time
from datetime import datetime
from html import unescape
from xml.etree import ElementTree

import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# .env loader (KEY=VALUE lines); real env vars win
_dotenv = os.path.join(app.root_path, ".env")
if os.path.exists(_dotenv):
    with open(_dotenv) as fh:
        for line in fh:
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                os.environ.setdefault(k, v)

CARTO_KEY = os.environ.get("CARTO_API_KEY", "")


def _load(name):
    with open(os.path.join(app.root_path, "static", name)) as fh:
        return json.load(fh)


ROUTES = _load("routes.json")  # {linea: {ida/vuelta: {shapes, stops}}}
STOPS_BY_ID = {s["id"]: s for s in _load("stops.json")}

EMT = "https://servicios.emtvalencia.es"
USER = "7gH8m45w7A"
# ponytail: static WSSE token replayed from the captured request. Verified live:
# buses/linea.php accepts it (fresh positions), but estimaciones suppresses data
# for stale/replayed tokens (200 + empty <bus/>). Fix = mint fresh tokens:
# PasswordDigest = b64(sha1(nonce + created + password)) — needs the app's secret
# password (extract from the EMT APK), it never travels over the wire.
WSSE = (
    f'UsernameToken Username="{USER}", '
    'PasswordDigest="ODdmMzU1OWU4ZDEwZGE0MDllM2E5NzhlZTg3Y2UxMmRjYTQ2N2VmYQ==", '
    'Nonce="MjZlNTNjMWIxZmZhMmU4NjE5N2QyYjhkMjgyMGU2YjU=", '
    'Created="1790762921"'
)
HEADERS = {
    "X-WSSE": WSSE,
    "Accept-Charset": "UTF-8",
    "Content-Type": "application/json; charset=UTF-8",
    "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 17; Pixel 8a Build/CP41.260831.007)",
}

_cache = {}  # (path, params) -> (expires_at, body)
TTL = 4


def emt_get(path, **params):
    key = (path, tuple(sorted(params.items())))
    hit = _cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    r = requests.get(f"{EMT}{path}", params=params, headers=HEADERS, timeout=10)
    r.raise_for_status()
    body = r.content
    _cache[key] = (time.time() + TTL, body)
    return body


def parse_estimations(xml):
    out = []
    for bus in ElementTree.fromstring(xml).iter("bus"):
        row = {
            "linea": bus.findtext("linea", "").strip(),
            "destino": bus.findtext("destino", "").strip(),
            "minutos": bus.findtext("minutos", "").strip(),
            "horaLlegada": bus.findtext("horaLlegada", "").strip(),
        }
        if any(v for k, v in row.items() if k != "horaLlegada"):  # server emits an all-empty <bus/> when the token is stale
            out.append(row)
    return out


def _eta_key(a, now):
    """Minutes until arrival: 'Next' -> 0, 'N min.' -> N, else a scheduled
    'hh:mm:ss' arrival (wrapping past midnight) -> minutes from now."""
    s = str(a.get("minutos", "")).lower()
    if s.startswith("next"):
        return 0
    m = re.match(r"\d+", s)
    if m:
        return int(m.group())
    tm = re.match(r"(\d+):(\d+):(\d+)", str(a.get("horaLlegada", "")))
    if tm:
        h, mi, se = map(int, tm.groups())
        now_s = now.hour * 3600 + now.minute * 60 + now.second
        target = h * 3600 + mi * 60 + se
        if target >= now_s:
            return (target - now_s) // 60
        return (target + 86400 - now_s) // 60
    return 10 ** 9


def itinerary(linea, direction):
    return (ROUTES.get(linea, {}).get(direction, {}) or {}).get("stops", [])


def bus_direction(linea, p_ult, p_sig):
    """Match a live bus to ida/vuelta via its (last stop, next stop) pair in the
    GTFS itineraries. Two passes: exact consecutive pair, then next-stop alone."""
    p_ult, p_sig = str(p_ult), str(p_sig)
    for exact_only in (True, False):
        for d in ("ida", "vuelta"):
            it = itinerary(linea, d)
            if p_sig not in it:
                continue
            if not exact_only:
                return d
            if p_ult in it and it.index(p_sig) == it.index(p_ult) + 1:
                return d
    return None


@app.get("/")
def index():
    return render_template("index.html", carto_key=CARTO_KEY)


@app.get("/favicon.ico")
def favicon():
    return app.send_static_file("emt-logo.png")


def norm_line(x):
    x = (x or "").strip().upper()
    return str(int(x)) if x.isdigit() else x


def parse_estado_html(html):
    """Incident cards from the EMT "estado del servicio" page. Each card carries
    its affected lines as <img alt="Línea 07 - …"> badges."""
    cards = []
    for sec in re.findall(r'<section class="estado-servicio">(.*?)</section>', html, re.S):
        text = unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", sec))).strip()
        m = re.search(r"Desde:\s*([0-9/]+)", text)
        lines = [norm_line(x) for x in re.findall(r'<img[^>]*alt="L[ií]nea\s+([A-Za-z0-9]+)', sec)]
        if not lines:  # fallback: parse line numbers from the title text
            head = text.split("Desde")[0]
            tm = re.search(r"(?i)l[ií]neas?\s+(?:nº\.?\s*)?([0-9A-Z][0-9A-Z0-9]*(?:[,\syc.\-]+[0-9A-Z][0-9A-Z0-9]*)*)", head)
            if tm:
                lines = [norm_line(x) for x in re.findall(r"[0-9A-Z][0-9A-Z0-9]*", tm.group(1))
                         if x not in ("Y", "C", "DE", "DEL", "LAS")]
        title = re.search(r"<h2[^>]*>\s*<a[^>]*>(.*?)</a>", sec, re.S)
        title = unescape(re.sub(r"<[^>]+>", "", title.group(1))).strip() if title else text[:160]
        cards.append({"title": title, "date": m.group(1) if m else "", "text": text, "lines": lines})
    return cards


_INCIDENTS = {"ts": 0.0, "data": []}
INCIDENTS_TTL = 1800


def fetch_incidents():
    if time.time() - _INCIDENTS["ts"] < INCIDENTS_TTL:
        return _INCIDENTS["data"]
    r = requests.get("https://www.emtvalencia.es/wp/estado-del-servicio/",
                     headers={"User-Agent": "Mozilla/5.0"}, timeout=25)
    r.raise_for_status()
    cards = parse_estado_html(r.text)
    _INCIDENTS.update(ts=time.time(), data=cards)
    return cards


@app.get("/api/incidents")
def incidents():
    linea = request.args.get("linea", "")
    try:
        cards = fetch_incidents()
    except Exception as e:
        return jsonify(error=str(e)), 502
    if linea:
        q = norm_line(linea)
        cards = [c for c in cards if q in c["lines"]]
    return jsonify({"incidents": cards})


@app.get("/api/buses")
def buses():
    linea = request.args.get("linea", "19")
    try:
        body = emt_get("/buses/linea.php", usuario=USER, linea=linea)
        # an empty body (or {"error":..}) just means the line has no buses in
        # service right now — not a failure
        data = json.loads(body) if body and body.strip() else {}
        if not isinstance(data, dict) or not isinstance(data.get("buses"), list):
            data = {"buses": []}
        for b in data["buses"]:
            b["dir"] = bus_direction(linea, b.get("pUlt"), b.get("pSig"))
        return jsonify(data)
    except (ValueError, requests.RequestException) as e:
        return jsonify(error=str(e)), 502


def haversine_km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + \
        math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def upcoming_stops(linea, direction, p_sig, lat, lon, limit=12):
    """Stops ahead of a bus with cumulative ETAs (dist along itinerary / 18 km/h)."""
    it = itinerary(linea, direction)
    try:
        start = it.index(str(p_sig))
    except ValueError:
        return []
    out, prev, total = [], (lat, lon), 0.0
    for sid in it[start:start + limit]:
        s = STOPS_BY_ID.get(int(sid))
        if not s:
            continue
        total += haversine_km(prev, (s["lat"], s["lon"]))
        prev = (s["lat"], s["lon"])
        out.append({"id": s["id"], "nombre": s["nombre"], "minutes": max(1, round(total / 18 * 60))})
    return out


@app.get("/api/bus/<linea>/<int:num>")
def bus_detail(linea, num):
    try:
        data = json.loads(emt_get("/buses/linea.php", usuario=USER, linea=linea))
    except (ValueError, requests.RequestException) as e:
        return jsonify(error=str(e)), 502
    bus = next((b for b in data.get("buses", []) if b.get("num") == num), None)
    if not bus:
        return jsonify(error="bus not on the road"), 404
    d = bus_direction(linea, bus.get("pUlt"), bus.get("pSig"))
    return jsonify({
        "linea": linea, "num": num, "dir": d, "tra": bus.get("tra", ""),
        "lat": bus["lat"], "lon": bus["lon"],
        "upcoming": upcoming_stops(linea, d, bus.get("pSig"), bus["lat"], bus["lon"]) if d else [],
    })


@app.get("/api/stop")
def stop_info():
    try:
        parada = int(request.args.get("parada", ""))
    except ValueError:
        return jsonify(error="bad stop number"), 400
    stop = STOPS_BY_ID.get(parada)
    if not stop:
        return jsonify(error="unknown stop"), 404

    arrivals, near = [], []
    for linea in stop["lineas"]:
        try:
            data = json.loads(emt_get("/buses/linea.php", usuario=USER, linea=linea))
        except (ValueError, requests.RequestException):
            continue
        best = None  # (dist_km, bus) — nearest bus still to reach the stop
        for b in data.get("buses", []):
            d = bus_direction(linea, b.get("pUlt"), b.get("pSig"))
            it = itinerary(linea, d) if d else []
            if not it or str(parada) not in it or str(b.get("pSig")) not in it:
                continue
            if it.index(str(b["pSig"])) >= it.index(str(parada)):
                continue  # already past the stop
            dist = haversine_km((b["lat"], b["lon"]), (stop["lat"], stop["lon"]))
            if best is None or dist < best[0]:
                best = (dist, b)
        if best:
            dist, b = best
            minutes = max(1, round(dist / 18 * 60))  # ponytail: assumes ~18 km/h door-to-door
            near.append({"linea": linea, "num": b["num"], "lat": b["lat"], "lon": b["lon"],
                         "dir": d, "destino": b.get("tra", ""), "minutos": minutes,
                         "dist": round(dist, 2)})
            arrivals.append({"linea": linea, "dir": d, "destino": b.get("tra", ""),
                             "minutos": f"{minutes} min.", "source": "computed"})

    # authoritative ETAs win when the WSSE token is fresh
    try:
        arrivals = parse_estimations(
            emt_get("/estimaciones/estimacion.php", idioma="en", parada=str(parada), adaptados="false")
        ) or arrivals
        for a in arrivals:
            a.setdefault("source", "emt")
    except (ElementTree.ParseError, requests.RequestException):
        pass

# closest buses first (numeric minutes — "10 min." must not sort before "2 min.",
    # "Next" = arriving now, and scheduled "hh:mm:ss" arrivals count from now)
    now = datetime.now()
    arrivals.sort(key=lambda a: _eta_key(a, now))
    near.sort(key=lambda b: b["minutos"])
    return jsonify({"stop": stop, "arrivals": arrivals, "buses": near})


@app.get("/api/estimaciones")
def estimaciones():
    parada = request.args.get("parada", "25")
    try:
        return jsonify(parse_estimations(
            emt_get("/estimaciones/estimacion.php", idioma="en", parada=parada, adaptados="false")))
    except (ElementTree.ParseError, requests.RequestException) as e:
        return jsonify(error=str(e)), 502


if __name__ == "__main__":
    app.run(debug=True, port=8000)

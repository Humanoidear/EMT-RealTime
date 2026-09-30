const THEMES = {
  dark: {
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    stop: "#e4e4e7", stopStroke: "#18181b", building: "#2a2a2e", routeOpacity: 0.6,
    ctxRoute: "#fb923c",
  },
  light: {
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    stop: "#3f3f46", stopStroke: "#ffffff", building: "#c9c9cf", routeOpacity: 0.8,
    ctxRoute: "#f97316",
  },
};
let theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";

const map = new maplibregl.Map({
  container: "map",
  style: THEMES[theme].style,
  center: [-0.3763, 39.4699],
  zoom: 13,
  pitch: 0,
  attributionControl: { compact: true },
  transformRequest: (url) => {
    if (!window.CARTO_KEY || !url.includes("basemaps.cartocdn.com")) return { url };
    return { url: url + (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(window.CARTO_KEY) };
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (n, c) => `<i data-lucide="${n}"${c ? ` class="${c}"` : ""}></i>`;
const icons = () => window.lucide && window.lucide.createIcons();
const setStatus = (id, icon, text, cls) => { $(id).innerHTML = `${ic(icon, cls)} ${esc(text)}`; icons(); };
const COLORS = { ida: "#3b82f6", vuelta: "#ef4444" };
const CORRECT_MS = 400;
const OFF_ROUTE_M = 150;
const EMPTY = { type: "FeatureCollection", features: [] };

let stops = null;
let stopById = null;
let routes = null;
let currentLine = null;
let incidentsByLine = null;   // Map(normalizedLine -> [incident, ...])
const busMarkers = new Map();
let nearMarkers = [];
let follow = null;
let me = null;
let userMarker = null;
let selectedStopId = null;
let searchTimer = null;

const stopName = (s) => String(s.nombre).replace(/\s*\(\d+\)\s*$/, "").trim();
const norm = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const fmtDist = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

/* official EMT line badge image */
const lineImg = (n, h) =>
  `<img class="line-img" style="height:${h || 22}px" alt="line ${esc(n)}" title="line ${esc(n)}" loading="lazy" ` +
  `src="https://geoportal.emtvalencia.es/ciudadano/icongenerator/create-line-image.php?` +
  `size=50&type=normal&lineNumber=${encodeURIComponent(n)}&showBorder=false&borderColor=white">`;

/* one distinct colour per line serving the selected stop */
const LINE_COLORS = [
  "#f97316", "#0ea5e9", "#e11d48", "#8b5cf6", "#14b8a6", "#f43f5e",
  "#6366f1", "#22c55e", "#f59e0b", "#06b6d4", "#a855f7", "#84cc16",
];
function contextLineColor(line) {
  if (!currentStop) return THEMES[theme].ctxRoute;
  const i = currentStop.lines.indexOf(String(line));
  return i >= 0 ? LINE_COLORS[i % LINE_COLORS.length] : THEMES[theme].ctxRoute;
}

/* ---------- dead-reckoning render loop ---------- */
let lastFrame = 0;
function tick(now) {
  const frameDt = Math.min(100, lastFrame ? now - lastFrame : 16);
  lastFrame = now;
  const k = 1 - Math.exp(-frameDt / CORRECT_MS);
  for (const a of busMarkers.values()) {
    if (a.route) {
      const age = now - a.obsT;
      const spd = age > 25000 ? 0 : a.spd;
      const target = a.hold ? a.hold.s : predictArc(a.sObs, spd, age / 1000, a.route.total);
      const kk = Math.abs(target - a.s) > 25 ? 1 - Math.exp(-frameDt / 2500) : k;
      a.s += (target - a.s) * kk;
      a.render = pointAt(a.route, a.s);
    } else {
      const pred = predictPos(a.obs, a.vel, now - a.obsT);
      const errM = Math.hypot(
        (pred[0] - a.render[0]) * Math.cos((a.render[1] * Math.PI) / 180),
        pred[1] - a.render[1]) * 111320;
      const kk = errM > 25 ? 1 - Math.exp(-frameDt / 2500) : k;
      a.render[0] += (pred[0] - a.render[0]) * kk;
      a.render[1] += (pred[1] - a.render[1]) * kk;
    }
    a.marker.setLngLat(a.render);
  }
  if (follow) {
    const a = busMarkers.get(follow.num);
    if (a && !map.isMoving()) {
      const opts = { center: a.render };
      if (a.route && a.spd > 1 && a.s < a.route.total - 5) {
        const target = routeBearing(a.route, a.s);
        a.face = a.face == null ? target : a.face + (((target - a.face + 540) % 360) - 180) * k;
        opts.bearing = a.face;
      }
      map.jumpTo(opts);
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function busEl(line, dir, near) {
  const el = document.createElement("div");
  el.className = "bus-pin" + (near ? " near" : "");
  const cls = (dir === "ida" || dir === "vuelta") ? "badge-" + dir : "";
  el.innerHTML = `<span class="badge ${cls}">${esc(line)}</span>`;
  return el;
}

/* ---------- route-constrained prediction helpers ---------- */
const routeCache = new Map();
function preparedRoutes(linea, dir) {
  if (!dir || !routes) return [];
  const key = `${linea}:${dir}`;
  if (!routeCache.has(key)) {
    const shapes = (((routes[linea] || {})[dir] || {}).shapes) || [];
    routeCache.set(key, shapes.map(prepareRoute).filter((r) => r.total > 5));
  }
  return routeCache.get(key);
}

function nearestRoute(linea, dir, lon, lat) {
  let best = null;
  for (const r of preparedRoutes(linea, dir)) {
    const p = projectOnRoute(r, lon, lat);
    if (!best || p.dist < best.p.dist) best = { route: r, p };
  }
  return best;
}

const stopArcCache = new WeakMap();
function stopArc(route, stop) {
  let m = stopArcCache.get(route);
  if (!m) { m = new Map(); stopArcCache.set(route, m); }
  const k = String(stop.id);
  if (!m.has(k)) m.set(k, projectOnRoute(route, stop.lon, stop.lat).s);
  return m.get(k);
}

/* ---------- map layers ---------- */
async function loadRoutes(linea) {
  if (!routes) routes = await (await fetch("/static/routes.json")).json();
  const r = routes[linea] || {};
  for (const dir of ["ida", "vuelta"]) {
    map.getSource("route-" + dir).setData({
      type: "FeatureCollection",
      features: ((r[dir] || {}).shapes || []).map((coords) => ({
        type: "Feature", properties: {},
        geometry: { type: "LineString", coordinates: coords.map(([lat, lon]) => [lon, lat]) },
      })),
    });
  }
}

function clearRouteData() {
  for (const dir of ["ida", "vuelta"]) {
    if (map.getSource("route-" + dir)) map.getSource("route-" + dir).setData(EMPTY);
  }
}

async function ensureStops() {
  if (!stops) {
    stops = await (await fetch("/static/stops.json")).json();
    stopById = new Map(stops.map((s) => [String(s.id), s]));
  }
  setStopsData();
}

function setStopsData() {
  if (!stops || !map.getSource("stops")) return;
  map.getSource("stops").setData({
    type: "FeatureCollection",
    features: stops.map((s) => ({
      type: "Feature",
      properties: { id: s.id, nombre: s.nombre, lineas: s.lineas.join(", "), lat: s.lat, lon: s.lon },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    })),
  });
}

function addMapLayers() {
  const t = THEMES[theme];
  if (!map.getSource("ctx-routes")) map.addSource("ctx-routes", { type: "geojson", data: EMPTY });
  if (!map.getLayer("ctx-routes")) {
    map.addLayer({
      id: "ctx-routes", type: "line", source: "ctx-routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": t.ctxRoute, "line-width": 3, "line-opacity": 0.6 },
    });
  }
  for (const dir of ["ida", "vuelta"]) {
    if (!map.getSource("route-" + dir)) map.addSource("route-" + dir, { type: "geojson", data: EMPTY });
    if (!map.getLayer("route-" + dir)) {
      map.addLayer({
        id: "route-" + dir, type: "line", source: "route-" + dir,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": COLORS[dir], "line-width": 4, "line-opacity": t.routeOpacity },
      });
    }
  }
  if (!map.getSource("stops")) map.addSource("stops", { type: "geojson", data: EMPTY });
  if (!map.getLayer("stops")) {
    map.addLayer({
      id: "stops", type: "circle", source: "stops",
      paint: {
        // hide stop dots when zoomed out past a certain distance
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 0, 12.5, 3, 16, 6],
        "circle-color": t.stop, "circle-opacity": 0.85,
        "circle-stroke-color": t.stopStroke, "circle-stroke-width": 1.5,
      },
    });
  }
  if (!map.getLayer("3d-buildings")) {
    map.addLayer({
      id: "3d-buildings", type: "fill-extrusion", source: "carto", "source-layer": "building",
      minzoom: 14,
      paint: {
        "fill-extrusion-color": t.building,
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 12],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.85,
      },
    });
  }
  map.off("click", "stops");
  map.on("click", "stops", (e) => {
    const p = e.features[0].properties;
    selectStop({ id: p.id, nombre: p.nombre, lineas: p.lineas, lat: p.lat, lon: p.lon });
  });
  map.off("mouseenter", "stops");
  map.on("mouseenter", "stops", () => { map.getCanvas().style.cursor = "pointer"; });
  map.off("mouseleave", "stops");
  map.on("mouseleave", "stops", () => { map.getCanvas().style.cursor = ""; });
  if (currentLine) loadRoutes(currentLine);
  if (stops) setStopsData(); else ensureStops();
}

/* ---------- theme ---------- */
function applyTheme(next) {
  theme = next;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
  $("theme-toggle").innerHTML = ic(theme === "dark" ? "sun" : "moon");
  icons();
  map.setStyle(THEMES[theme].style);
  map.once("style.load", addMapLayers);
}

/* ---------- line tracking (revealed by tapping a line in a stop) ---------- */
function updateTrackChip() {
  const chip = $("track-chip");
  if (!currentLine) { chip.hidden = true; return; }
  chip.hidden = false;
  $("track-chip-line").textContent = currentLine;
  $("track-chip-text").textContent = busMarkers.size
    ? `${busMarkers.size} bus${busMarkers.size === 1 ? "" : "es"}`
    : "no buses now";
  icons();
}

function toggleLine(line) {
  if (currentLine === line) {        // tap again: stop revealing it
    untrackLine();
    return;
  }
  if (follow) stopFollow();          // picking a line drops any followed bus
  currentLine = line;
  // Markers are keyed by bus number only, which is per-line — a stale marker
  // from the previous line would carry over its route/speed state, so rebuild.
  for (const a of busMarkers.values()) a.marker.remove();
  busMarkers.clear();
  loadRoutes(line);
  loadBuses();
  updateTrackChip();
  highlightActiveLine();
  if (currentStop) renderStopView();
}

function untrackLine() {
  if (follow) stopFollow();
  currentLine = null;
  for (const a of busMarkers.values()) a.marker.remove();
  busMarkers.clear();
  clearRouteData();
  updateTrackChip();
  highlightActiveLine();
  if (currentStop) renderStopView();   // back to every line serving the stop
}

function highlightActiveLine() {
  for (const el of document.querySelectorAll(".eta-row.clickable")) {
    el.classList.toggle("active", el.dataset.line === currentLine);
  }
}

/* ---------- live buses for the revealed line ---------- */
async function loadBuses() {
  const linea = currentLine;
  if (!linea) return;
  try {
    const res = await fetch(`/api/buses?linea=${encodeURIComponent(linea)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    const seen = new Set();
    const now = performance.now();
    for (const b of data.buses || []) {
      seen.add(b.num);
      const pos = [b.lon, b.lat];
      let a = busMarkers.get(b.num);
      if (!a) {
        const el = busEl(b.lin, b.dir, false);
        el.addEventListener("click", (e) => { e.stopPropagation(); followBus(linea, b.num); });
        const cand = nearestRoute(linea, b.dir, pos[0], pos[1]);
        const onRoute = cand && cand.p.dist <= OFF_ROUTE_M;
        const render = onRoute ? pointAt(cand.route, cand.p.s) : pos.slice();
        a = {
          marker: new maplibregl.Marker({ element: el }).setLngLat(render).addTo(map),
          dir: b.dir, ts: b.ts, face: null, hold: null,
          obs: pos, obsT: now, vel: [0, 0], render,
          route: onRoute ? cand.route : null,
          s: onRoute ? cand.p.s : 0,
          sObs: onRoute ? cand.p.s : 0,
          spd: 0,
        };
        busMarkers.set(b.num, a);
      } else {
        const fresh = b.ts !== a.ts;
        const moved = Math.abs(pos[0] - a.obs[0]) > 1e-6 || Math.abs(pos[1] - a.obs[1]) > 1e-6;
        if (fresh) {
          if (moved) {
            const dtS = a.ts ? (Date.parse(b.ts) - Date.parse(a.ts)) / 1000 : 0;
            const cand = nearestRoute(linea, b.dir, pos[0], pos[1]);
            if (cand && cand.p.dist <= OFF_ROUTE_M) {
              if (a.route !== cand.route) {
                a.route = cand.route;
                const p0 = projectOnRoute(a.route, a.render[0], a.render[1]);
                a.s = p0.dist <= OFF_ROUTE_M ? p0.s : cand.p.s;
              } else if (dtS > 0.5) {
                a.spd = (a.spd + clampSpeed((cand.p.s - a.sObs) / dtS)) / 2;
              }
              a.sObs = cand.p.s;
            } else {
              a.route = null;
              if (dtS > 0.5) {
                const raw = clampVelocity(
                  [(pos[0] - a.obs[0]) / (dtS * 1000), (pos[1] - a.obs[1]) / (dtS * 1000)], pos[1]);
                a.vel = [a.vel[0] * 0.5 + raw[0] * 0.5, a.vel[1] * 0.5 + raw[1] * 0.5];
              }
            }
            a.obs = pos;
            a.obsT = now;
          } else {
            a.spd *= 0.5;
            a.obsT = now;
          }
          a.ts = b.ts;
          if (a.route) {
            const stop = stopById && stopById.get(String(b.pSig));
            a.hold = stopHold(a.hold, a.sObs, b.pSig, stop ? stopArc(a.route, stop) : null);
          }
        }
      }
      if (a.dir !== b.dir) {
        a.dir = b.dir;
        const badge = a.marker.getElement().querySelector(".badge");
        if (badge) {
          badge.className = "badge " + ((b.dir === "ida" || b.dir === "vuelta") ? "badge-" + b.dir : "");
        }
      }
      a.marker.getElement().title = `Line ${b.lin} · ${b.tra} · next stop ${b.pSig} (${b.dir || "?"})`;
      // exactly the followed bus keeps the highlight; everyone else drops it
      a.marker.getElement().classList.toggle("following",
        !!(follow && follow.linea === linea && follow.num === b.num));
    }
    for (const [num, a] of busMarkers) {
      if (!seen.has(num)) { a.marker.remove(); busMarkers.delete(num); }
    }
    updateTrackChip();
    if (follow && follow.linea === linea && busMarkers.has(follow.num)) {
      refreshFollow();
    } else if (follow) {
      stopFollow();
    }
  } catch (e) {
    $("track-chip-text").textContent = `unavailable`;
  }
}

/* ---------- follow a bus ---------- */
function followBus(linea, num) {
  if (follow && follow.num === num) return;      // already following this one
  follow = { linea, num };
  // change of follow target: rebuild every bus dot from scratch so no stale
  // number / highlight carries over
  for (const a of busMarkers.values()) a.marker.remove();
  busMarkers.clear();
  $("follow-card").hidden = false;
  $("follow-title").textContent = `Line ${linea} · bus ${num}`;
  loadBuses();
  refreshFollow();
}

function stopFollow() {
  if (follow) {
    const a = busMarkers.get(follow.num);
    if (a) a.marker.getElement().classList.remove("following");
  }
  follow = null;
  $("follow-card").hidden = true;
}

async function refreshFollow() {
  if (!follow) return;
  try {
    const res = await fetch(`/api/bus/${encodeURIComponent(follow.linea)}/${follow.num}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.status);
    $("follow-sub").textContent = `${d.dir || "?"} · ${d.tra}`;
    const up = d.upcoming || [];
    const list = $("follow-list");
    if (!up.length) {
      if (!list.querySelector(".empty")) {
        list.innerHTML = `<li class="eta-row empty">${ic("circle-slash")} No stops ahead</li>`;
        icons();
      }
      return;
    }
    const existing = new Map([...list.children].map((li) => [li.dataset.id, li]));
    const keep = new Set();
    up.forEach((s, i) => {
      const key = String(s.id);
      keep.add(key);
      let li = existing.get(key);
      if (!li) {
        li = document.createElement("li");
        li.className = "eta-row";
        li.dataset.id = key;
        li.innerHTML = `<span class="badge"></span><span class="stop-meta">` +
          `<span class="eta-dest"></span></span>` +
          `<span class="eta-time">${ic("clock")}<span></span></span>`;
      }
      const badge = li.querySelector(".badge");
      const label = i === 0 ? "next" : String(i + 1);
      const cls = i === 0 ? `badge badge-${d.dir || "secondary"}` : "badge";
      if (badge.textContent !== label || badge.className !== cls) { badge.textContent = label; badge.className = cls; }
      const dest = li.querySelector(".eta-dest");
      const name = stopName(s);
      if (dest.textContent !== name) dest.textContent = name;
      const mins = li.querySelector(".eta-time span");
      const txt = `${s.minutes} min.`;
      if (mins.textContent !== txt) {
        mins.textContent = txt;
        li.classList.add("tick");
        setTimeout(() => li.classList.remove("tick"), 420);
      }
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
    });
    for (const li of [...list.children]) {
      if (!keep.has(li.dataset.id)) li.remove();
    }
    icons();
  } catch (e) {
    $("follow-sub").textContent = `error: ${e.message}`;
  }
}

/* ---------- stop finder: locate, search ---------- */
function nearbyStops(lat, lon, limit) {
  return (stops || [])
    .map((s) => ({ ...s, dist: haversineM([lon, lat], [s.lon, s.lat]) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit || 12);
}

function renderStopList(items, showDist) {
  const list = $("stop-list");
  list.innerHTML = items.map((s) => `
    <li class="stop-row${String(s.id) === selectedStopId ? " selected" : ""}" data-id="${s.id}">
      <span class="stop-icon">${ic("map-pin")}</span>
      <span class="stop-meta">
        <span class="stop-name">${esc(stopName(s))}</span>
        <span class="stop-lines">${esc((s.lineas || []).join(" · "))}</span>
      </span>
      ${showDist && s.dist != null ? `<span class="stop-dist">${fmtDist(s.dist)}</span>` : ""}
    </li>`).join("");
  icons();
  for (const li of list.children) {
    li.addEventListener("click", () => {
      const s = (stops || []).find((x) => String(x.id) === li.dataset.id);
      if (s) selectStop(s);
    });
  }
}

function locate() {
  if (!navigator.geolocation) {
    setStatus("stop-status", "triangle-alert", "Geolocation is not supported here");
    return;
  }
  setStatus("stop-status", "loader", "locating…", "spin");
  navigator.geolocation.getCurrentPosition((pos) => {
    me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    if (userMarker) userMarker.remove();
    const dot = document.createElement("div");
    dot.className = "user-dot";
    dot.title = "Your location";
    userMarker = new maplibregl.Marker({ element: dot }).setLngLat([me.lon, me.lat]).addTo(map);
    const near = nearbyStops(me.lat, me.lon);
    renderStopList(near, true);
    setStatus("stop-status", "navigation", `${near.length} stops around you`);
    const b = new maplibregl.LngLatBounds([me.lon, me.lat], [me.lon, me.lat]);
    for (const s of near.slice(0, 6)) b.extend([s.lon, s.lat]);
    map.fitBounds(b, { padding: 60, maxZoom: 16, duration: 1200 });
  }, (err) => {
    setStatus("stop-status", "triangle-alert", err.message || "location unavailable");
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}

function onSearch(e) {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!q) {
    $("stop-list").innerHTML = "";
    setStatus("stop-status", "map-pin", "Search a stop or use your location");
    return;
  }
  searchTimer = setTimeout(() => {
    const n = norm(q);
    const words = n.split(/\s+/).filter(Boolean);
    const byNumber = /^\d+$/.test(n);
    let hits = (stops || []).filter((s) => {
      if (byNumber) return String(s.id).includes(n);
      const name = norm(s.nombre);
      return words.every((w) => name.includes(w));
    });
    if (me) {
      hits = hits.map((s) => ({ ...s, dist: haversineM([me.lon, me.lat], [s.lon, s.lat]) }))
        .sort((a, b) => a.dist - b.dist);
    }
    hits = hits.slice(0, 20);
    renderStopList(hits, !!me);
    if (hits.length) setStatus("stop-status", "search", `${hits.length} stop${hits.length > 1 ? "s" : ""} found`);
    else setStatus("stop-status", "circle-slash", "No stop matches that name");
  }, 160);
}

/* ---------- favorites (localStorage) ---------- */
function getFavs() {
  try { return JSON.parse(localStorage.getItem("emt.favs") || "[]"); } catch { return []; }
}
function setFavs(favs) { localStorage.setItem("emt.favs", JSON.stringify(favs)); renderFavs(); updateFavButton(); }

function toggleFav(id) {
  const favs = getFavs();
  const on = favs.includes(id);
  setFavs(on ? favs.filter((x) => x !== id) : favs.concat(id));
}

function renderFavs() {
  const ids = getFavs();
  const items = ids.map((id) => (stopById && stopById.get(String(id))) || null).filter(Boolean);
  $("fav-section").hidden = !items.length;   // only show favorites when there are some
  $("fav-count").textContent = items.length || "";
  const list = $("fav-list");
  list.innerHTML = items.map((s) => `
    <li class="stop-row" data-id="${s.id}">
      <span class="stop-icon">${ic("star")}</span>
      <span class="stop-meta">
        <span class="stop-name">${esc(stopName(s))}</span>
        <span class="stop-lines">${esc(s.lineas.join(" · "))}</span>
      </span>
      <button class="icon-btn ghost fav-remove" title="Remove"><i data-lucide="x"></i></button>
    </li>`).join("");
  icons();
  for (const li of list.children) {
    li.addEventListener("click", (e) => {
      if (e.target.closest(".fav-remove")) { toggleFav(li.dataset.id); return; }
      const s = (stops || []).find((x) => String(x.id) === li.dataset.id);
      if (s) selectStop(s);
    });
  }
}

function updateFavButton() {
  const on = !!selectedStopId && getFavs().includes(selectedStopId);
  const b = $("stop-panel-fav");
  b.classList.toggle("active", on);
  b.title = on ? "Remove from favorites" : "Save to favorites";
}

/* ---------- incidents (EMT estado del servicio) ---------- */
async function loadIncidents() {
  if (incidentsByLine) return;
  incidentsByLine = new Map();
  try {
    const res = await fetch("/api/incidents");
    const d = await res.json();
    for (const inc of d.incidents || []) {
      for (const l of inc.lines) {
        if (!incidentsByLine.has(l)) incidentsByLine.set(l, []);
        incidentsByLine.get(l).push(inc);
      }
    }
  } catch { /* incidents are best-effort */ }
}

let updatesOpen = true;   // service-updates block collapse state (kept across refreshes)

function renderServiceUpdates(lines) {
  const entries = [];
  for (const l of lines) {
    const incs = (incidentsByLine && incidentsByLine.get(String(l).trim().toUpperCase())) || [];
    if (incs.length) entries.push([l, incs[0]]);
  }
  const el = $("stop-incidents");
  if (!entries.length) { el.innerHTML = ""; el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <button class="updates-head" id="updates-toggle" title="Toggle service updates">
      ${ic("triangle-alert")}<span>Service updates</span><span class="fav-count">${entries.length}</span>
      <i data-lucide="chevron-down" class="chev"></i>
    </button>
    <div class="updates-body">${entries.map(([l, inc]) => `
      <div class="incident">${ic("triangle-alert")}<span>${lineImg(l, 18)} ${esc(inc.title)}${inc.date ? ` <small>(${esc(inc.date)})</small>` : ""}</span></div>`).join("")}
    </div>`;
  el.classList.toggle("collapsed", !updatesOpen);
  $("updates-toggle").addEventListener("click", () => {
    updatesOpen = !updatesOpen;
    el.classList.toggle("collapsed", !updatesOpen);
  });
  icons();
}

/* ---------- stop panel ---------- */
let currentStop = null;   // {full, lines, data} of the selected stop

/* Renders the panel + map for the selected stop. When a line is being revealed
   only that line's arrivals, buses and route are shown — everything else is
   dropped. `fit` re-zooms the map to the approaching buses (selection only). */
function lineShapes(line) {
  const r = (routes || {})[line];
  if (!r) return [];
  return [...(((r.ida || {}).shapes) || []), ...(((r.vuelta || {}).shapes) || [])];
}

/* Renders the panel + map for the selected stop.
   - The panel always lists every line's times.
   - On the map: when a line is focused only that line is drawn (its own route +
     buses); otherwise every line of the stop in its own colour. `fit` zooms to
     the stop's lines once on selection. */
function renderStopView(fit) {
  if (!currentStop) return;
  const { data, lines } = currentStop;
  const focused = currentLine && lines.includes(currentLine);
  renderArrivals(data, "eta-list");
  showContextRoutes(focused ? [] : lines);
  renderServiceUpdates(lines);
  $("eta-status").innerHTML = (data.arrivals && data.arrivals[0] && data.arrivals[0].source === "computed")
    ? `${ic("calculator")} estimated from live positions` : "";
  if (fit) {
    const b = new maplibregl.LngLatBounds(
      [data.stop.lon, data.stop.lat], [data.stop.lon, data.stop.lat]);
    for (const line of lines) {
      for (const coords of lineShapes(line)) for (const [lat, lon] of coords) b.extend([lon, lat]);
    }
    map.fitBounds(b, { padding: 80, maxZoom: 15, duration: 1200 });
  }
  icons();
}

/* keep the open stop's times live */
async function refreshStop() {
  if (!currentStop) return;
  try {
    const res = await fetch(`/api/stop?parada=${currentStop.full.id}`);
    const data = await res.json();
    if (!res.ok || data.error) return;
    currentStop.data = data;
    renderStopView(false);   // update times / buses without re-zooming the map
  } catch { /* keep showing the last data */ }
}

function clearNear() {
  for (const m of nearMarkers) m.remove();
  nearMarkers = [];
}

function renderArrivals(data, listId) {
  const byLine = new Map();
  for (const b of data.buses || []) {
    if (!byLine.has(String(b.linea))) byLine.set(String(b.linea), b);
  }
  const rows = (data.arrivals || []).map((a) => {
    const line = String(a.linea);
    const b = byLine.get(line);
    const sub = b ? `bus ${b.num}${b.dist != null ? ` · ${fmtDist(b.dist * 1000)}` : ""}` : "";
    const incs = (incidentsByLine && incidentsByLine.get(line.toUpperCase())) || [];
    const when = a.minutos || (a.horaLlegada ? a.horaLlegada.slice(0, 5) : "—");
    return `<li class="eta-row clickable" data-line="${esc(line)}" title="Tap to reveal line ${esc(line)} on the map">
      <span class="line-dot" style="background:${contextLineColor(line)}"></span>
      ${lineImg(line)}
      <span class="stop-meta">
        <span class="eta-dest">${esc(a.destino || line)}</span>
        ${sub ? `<span class="eta-bus">${esc(sub)}</span>` : ""}
      </span>
      ${incs.length ? `<span class="warn-ico" title="Service notice: ${esc(incs[0].title)}">${ic("triangle-alert")}</span>` : ""}
      <span class="eta-time">${ic("clock")}${esc(when)}</span>
    </li>`;
  }).join("");
  $(listId).innerHTML = rows ||
    `<li class="eta-row empty">${ic("circle-slash")} No buses coming right now</li>`;
  icons();
  for (const el of $(listId).querySelectorAll(".eta-row.clickable")) {
    el.addEventListener("click", () => toggleLine(el.dataset.line));
  }
  highlightActiveLine();
}

function showContextRoutes(lines) {
  const feats = [];
  for (const line of lines) {
    for (const coords of lineShapes(line)) {
      feats.push({
        type: "Feature", properties: { linea: line },
        geometry: { type: "LineString", coordinates: coords.map(([lat, lon]) => [lon, lat]) },
      });
    }
  }
  if (!map.getSource("ctx-routes")) return;
  map.getSource("ctx-routes").setData({ type: "FeatureCollection", features: feats });
  // one colour per line, stable for the stop's line order
  const expr = ["match", ["get", "linea"]];
  lines.forEach((line, i) => expr.push(line, LINE_COLORS[i % LINE_COLORS.length]));
  expr.push(THEMES[theme].ctxRoute);
  map.setPaintProperty("ctx-routes", "line-color", expr);
}

function clearContextRoutes() {
  if (map.getSource("ctx-routes")) map.getSource("ctx-routes").setData(EMPTY);
}

async function selectStop(stop) {
  if (currentLine || follow) untrackLine();   // a selected stop clears any bus/line focus
  clearNear();
  selectedStopId = String(stop.id);
  const full = (stopById && stopById.get(selectedStopId)) || stop;
  const lines = Array.isArray(full.lineas) ? full.lineas : String(full.lineas || "").split(",");
  $("stop-panel").hidden = false;
  $("stop-panel-name").textContent = stopName(full);
  $("stop-panel-sub").textContent = `stop ${full.id} · lines ${lines.join(", ")}`;
  updateFavButton();
  for (const el of document.querySelectorAll(".stop-row")) {
    el.classList.toggle("selected", el.dataset.id === selectedStopId);
  }
  $("eta-list").innerHTML = `<li class="eta-row">${ic("loader", "spin")} loading…</li>`;
  $("stop-incidents").innerHTML = "";
  $("eta-status").innerHTML = "";
  icons();
  try {
    if (!routes) routes = await (await fetch("/static/routes.json")).json();
    await loadIncidents();
    const res = await fetch(`/api/stop?parada=${full.id}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.status);
    currentStop = {
      full,
      lines: lines.map((l) => String(l).trim()).filter(Boolean),
      data,
    };
    renderStopView(true);
  } catch (e) {
    $("eta-list").innerHTML = "";
    setStatus("eta-status", "triangle-alert", e.message);
  }
}

function closeStopPanel() {
  $("stop-panel").hidden = true;
  selectedStopId = null;
  currentStop = null;
  updateFavButton();
  for (const el of document.querySelectorAll(".stop-row.selected")) el.classList.remove("selected");
  clearNear();
  clearContextRoutes();
}

/* ---------- wiring ---------- */
$("sidebar-toggle").addEventListener("click", () => $("sidebar").classList.toggle("collapsed"));
$("theme-toggle").addEventListener("click", () => applyTheme(theme === "dark" ? "light" : "dark"));
$("follow-stop").addEventListener("click", stopFollow);
$("locate").addEventListener("click", locate);
$("stop-search").addEventListener("input", onSearch);
$("stop-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && $("stop-list").firstElementChild) $("stop-list").firstElementChild.click();
});
$("stop-panel-close").addEventListener("click", closeStopPanel);
$("stop-panel-fav").addEventListener("click", () => {
  if (selectedStopId) toggleFav(selectedStopId);
});
$("track-chip").addEventListener("click", untrackLine);
$("toggle-3d").addEventListener("click", () => {
  const flat = map.getPitch() < 20;
  map.easeTo({ pitch: flat ? 60 : 0, duration: 900 });
  $("toggle-3d").classList.toggle("active", flat);
});
$("theme-toggle").innerHTML = ic(theme === "dark" ? "sun" : "moon");
icons();

map.on("load", () => {
  addMapLayers();
  ensureStops();
  renderFavs();
  setInterval(loadBuses, 5000);
  setInterval(refreshStop, 10000);   // live stop times
});
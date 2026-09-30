/* Motion math for bus dead-reckoning. Pure functions, shared by the app and tests. */
const M_PER_DEG = 111320;

/* Clamp a deg/ms velocity to a sane city-bus speed; treat near-zero as stopped. */
function clampVelocity(v, lat, maxSpeedMps) {
  const cap = maxSpeedMps || 15;
  const cos = Math.cos((lat * Math.PI) / 180) || 1e-6;
  const mps = Math.hypot(v[1] * M_PER_DEG, v[0] * M_PER_DEG * cos) * 1000;
  if (mps < 0.3) return [0, 0];
  const s = Math.min(1, cap / mps);
  return [v[0] * s, v[1] * s];
}

/* Extrapolate the last observation along its velocity; freeze if data goes stale. */
function predictPos(obs, vel, dtMs, maxAgeMs) {
  if (dtMs > (maxAgeMs || 25000)) return obs.slice();
  return [obs[0] + vel[0] * dtMs, obs[1] + vel[1] * dtMs];
}

/* ---------- route-constrained motion ----------
   Buses are predicted along the GTFS polyline: we keep an arc-length position
   (metres) and a scalar speed, so the marker follows the road instead of
   cutting across blocks. */
const R_EARTH = 6371000;
const M_PER_LAT = 111320;

function toRad(d) { return (d * Math.PI) / 180; }

function haversineM(a, b) {  // a, b = [lon, lat]
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/* shapes come in as [[lat, lon], ...]; store as [lon, lat] + cumulative metres */
function prepareRoute(latLonPts) {
  const pts = latLonPts.map(([lat, lon]) => [lon, lat]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineM(pts[i - 1], pts[i]));
  return { pts, cum, total: cum[cum.length - 1] || 0 };
}

/* nearest point on the route: {s: arc-length m, dist: metres off-route} */
function projectOnRoute(route, lon, lat) {
  const mPerLon = M_PER_LAT * Math.cos(toRad(lat)) || 1e-6;
  let best = { s: 0, dist: Infinity };
  for (let i = 1; i < route.pts.length; i++) {
    const ax = (route.pts[i - 1][0] - lon) * mPerLon, ay = (route.pts[i - 1][1] - lat) * M_PER_LAT;
    const bx = (route.pts[i][0] - lon) * mPerLon, by = (route.pts[i][1] - lat) * M_PER_LAT;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t, ay + dy * t);
    if (d < best.dist) {
      best = { dist: d, s: route.cum[i - 1] + haversineM(route.pts[i - 1], route.pts[i]) * t };
    }
  }
  return best;
}

/* position at arc-length s along the route -> [lon, lat] */
function pointAt(route, s) {
  const sc = s < 0 ? 0 : s > route.total ? route.total : s;
  let lo = 0, hi = route.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (route.cum[mid] <= sc) lo = mid; else hi = mid;
  }
  const seg = route.cum[hi] - route.cum[lo];
  const t = seg ? (sc - route.cum[lo]) / seg : 0;
  return [
    route.pts[lo][0] + (route.pts[hi][0] - route.pts[lo][0]) * t,
    route.pts[lo][1] + (route.pts[hi][1] - route.pts[lo][1]) * t,
  ];
}

/* scalar speed clamp (m/s): stop below walking pace, cap at city-bus speed */
function clampSpeed(mps, maxSpeedMps) {
  if (mps < 0.3) return 0;
  return Math.min(mps, maxSpeedMps || 15);
}

/* Extrapolate arc-length from the last observation (never past the route ends). */
function predictArc(sObs, spd, dtS, total) {
  const s = sObs + spd * dtS;
  return s < 0 ? 0 : s > total ? total : s;
}

/* Compass bearing (deg, 0 = north, cw) of travel at arc-length s along the route. */
function routeBearing(route, s) {
  const ahead = 15;
  let a = pointAt(route, s);
  let b = pointAt(route, Math.min(route.total, s + ahead));
  if (s + ahead > route.total) {   // near the terminus: look backwards instead
    a = pointAt(route, Math.max(0, s - ahead));
    b = pointAt(route, s);
  }
  const dLon = (b[0] - a[0]) * Math.cos(toRad(a[1]));
  const dLat = b[1] - a[1];
  return (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
}

/* Stop hold: a bus within arriveM of its next stop is assumed to be serving it,
   so prediction pins it there until it is seen leaving (leaveM of hysteresis,
   or the next-stop id changing once it is past). Returns the new hold or null. */
function stopHold(hold, sProj, pSig, sStop, arriveM, leaveM) {
  const arrive = arriveM == null ? 35 : arriveM;
  const leave = leaveM == null ? 30 : leaveM;
  const id = pSig == null ? null : String(pSig);
  if (hold) {
    const gone = sProj > hold.s + leave || (id !== hold.id && sProj > hold.s - 10);
    return gone ? null : hold;
  }
  if (sStop == null || id == null) return null;
  return Math.abs(sProj - sStop) <= arrive ? { id, s: sStop } : null;
}

if (typeof module !== "undefined") {
  module.exports = {
    clampVelocity, predictPos, prepareRoute, projectOnRoute, pointAt, clampSpeed,
    predictArc, routeBearing, stopHold, M_PER_DEG,
  };
}

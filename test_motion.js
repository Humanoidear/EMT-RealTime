/* Run: node test_motion.js */
const {
  clampVelocity, predictPos, prepareRoute, projectOnRoute, pointAt, clampSpeed,
  predictArc, routeBearing, stopHold,
} = require("./static/motion.js");

const lat = 39.4699;
const cos = Math.cos((lat * Math.PI) / 180);

// stopped bus -> zero velocity (no phantom drift); 1e-10 deg/ms is ~0.009 m/s
assert(clampVelocity([1e-10, 0], lat), [0, 0]);
assert(clampVelocity([0, 0], lat), [0, 0]);

// ~3 m/s east is kept as-is
const v3 = [3 / (111320 * cos) / 1000, 0];
assert(clampVelocity(v3, lat), v3, 1e-12);

// ~60 m/s gets clamped to the 15 m/s cap
const fast = [60 / (111320 * cos) / 1000, 0];
const clamped = clampVelocity(fast, lat);
const mps = Math.hypot(clamped[1] * 111320, clamped[0] * 111320 * cos) * 1000;
assert(round(mps), 15, 0.01);

// prediction advances along velocity, then freezes when stale
assert(predictPos([0, 0], [0.001, 0], 1000), [1, 0], 1e-12);
assert(predictPos([0, 0], [0.001, 0], 30000), [0, 0], 1e-12);

// ---- route-constrained motion ----
// L-shaped polyline: ~111 m north, then ~172 m east
const route = prepareRoute([
  [39.4700, -0.3800],
  [39.4710, -0.3800],
  [39.4710, -0.3780],
]);
assert(route.total, 111.2 + 171.9, 2);

// a fix 8 m east of the first leg, ~56 m along it
const pr = projectOnRoute(route, -0.3799, 39.4705);
assert(pr.dist, 8.6, 2);
assert(pr.s, 55.7, 2);

// round-trip: points sampled along the route project back onto themselves
for (const s of [0, 50, 111, 150, route.total]) {
  const p = pointAt(route, s);
  const back = projectOnRoute(route, p[0], p[1]);
  assert(back.dist, 0, 1);
  assert(back.s, s, 1);
}

// arc-length clamps to the route ends
assert(pointAt(route, -20), pointAt(route, 0), 1e-12);
assert(pointAt(route, route.total + 200), pointAt(route, route.total), 1e-12);

// scalar speed clamp
assert(clampSpeed(0.1), 0);
assert(clampSpeed(5), 5);
assert(clampSpeed(60), 15, 1e-12);

// arc-length extrapolation advances, then clamps at the route ends
assert(predictArc(100, 10, 5, 1000), 150);
assert(predictArc(990, 10, 5, 1000), 1000);
assert(predictArc(5, -10, 5, 1000), 0);
assert(predictArc(100, 0, 300, 1000), 100);

// travel bearing along the L-shaped route: north leg -> 0, east leg -> 90
assert(routeBearing(route, 50), 0, 1);
assert(routeBearing(route, route.total - 20), 90, 1);

// stop hold: arrive, stay, then leave only when actually seen departing
const eqHold = (got, want) => {
  const ok = (got === null && want === null) ||
    (got && want && got.id === want.id && got.s === want.s);
  if (!ok) throw new Error(`hold mismatch: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
};
eqHold(stopHold(null, 100, 25, 110), { id: "25", s: 110 });   // at the stop -> hold
eqHold(stopHold(null, 60, 25, 110), null);                    // still far away
eqHold(stopHold(null, 100, 25, null), null);                  // no stop geometry
const held = { id: "25", s: 110 };
eqHold(stopHold(held, 118, 25, 110), held);                   // jitter at the stop
eqHold(stopHold(held, 150, 25, 110), null);                   // driven away -> release
eqHold(stopHold(held, 200, 26, 250), null);                   // next-stop id moved on

function round(x) { return x; }
function assert(got, want, eps = 1e-9) {
  const g = Array.isArray(got) ? got : [got], w = Array.isArray(want) ? want : [want];
  g.forEach((x, i) => {
    if (Math.abs(x - w[i]) > eps) throw new Error(`got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  });
}
console.log("ok");

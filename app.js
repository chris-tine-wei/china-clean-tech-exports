/* ============================================================================
   China's Clean Tech Exports — scrollytelling flow map
   Mapbox GL JS + Scrollama.  Data: Ember (CC-BY-4.0).
   ----------------------------------------------------------------------------
   PASTE YOUR MAPBOX TOKEN BELOW (public token, starts with "pk.").
   Get a free one at https://account.mapbox.com/access-tokens/
============================================================================ */
const MAPBOX_TOKEN = "pk.eyJ1IjoiY2hyaXN0aW5lcC0iLCJhIjoiY21xb3lrazJ0MDF5ZTJyc2dyMWljcTF6dSJ9.wlE8TS4YnDWJRqUCM9x3ZA";

// allow override via window.MAPBOX_TOKEN or ?token= for convenience
const TOKEN =
  (typeof window !== "undefined" && window.MAPBOX_TOKEN) ||
  new URLSearchParams(location.search).get("token") ||
  MAPBOX_TOKEN;

const ACCENT = "#2fe6d6";
const ACCENT_HI = "#b6fdf3";
const FOCUS_COUNTRIES = ["Nigeria", "Kenya", "Ethiopia"];        // labelled on Africa step
const MIDEAST_LABELS = ["United Arab Emirates", "Saudi Arabia"]; // labelled on Gulf step
const SHORT_NAME = { "United Arab Emirates": "UAE" };
const dispName = (n) => SHORT_NAME[n] || n;

// Camera framing per narrative step
const STEPS = [
  { center: [46, 18], zoom: 1.5,  pitch: 0,  filter: "all",         label: "global" },
  { center: [21, 4],  zoom: 2.45, pitch: 15, filter: "Africa",      label: "africa" },
  { center: [26, 7],  zoom: 2.15, pitch: 10, filter: "Africa",      label: "drivers" },
  { center: [49, 26], zoom: 3.0,  pitch: 20, filter: "Middle East", label: "mideast" },
  { center: [60, 16], zoom: 1.65, pitch: 0,  filter: "dim",         label: "coda" },
  { center: [52, 18], zoom: 1.55, pitch: 0,  filter: "all",         label: "timeline" },
];

let MAP, FLOWS, CENTROIDS, ORIGIN, ARC_FC, MONTHLY;
let INTRO = { active: false, start: 0 };
let HOLD = { active: false, done: false };
let _holdTouchY = 0;
let currentStep = -1;

/* --------------------------------------------------------- geojson helpers */
function fpoint(coords, props) {
  return { type: "Feature", geometry: { type: "Point", coordinates: coords }, properties: props || {} };
}
function fc(features) {
  return { type: "FeatureCollection", features };
}
// great-circle line between two [lon,lat] points (slerp), with longitude
// unwrapping so arcs that cross the antimeridian draw without a seam.
function greatCircleLine(from, to, n = 64) {
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const [lo1, la1] = from, [lo2, la2] = to;
  const f1 = rad(la1), l1 = rad(lo1), f2 = rad(la2), l2 = rad(lo2);
  const v1 = [Math.cos(f1) * Math.cos(l1), Math.cos(f1) * Math.sin(l1), Math.sin(f1)];
  const v2 = [Math.cos(f2) * Math.cos(l2), Math.cos(f2) * Math.sin(l2), Math.sin(f2)];
  let dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  dot = Math.max(-1, Math.min(1, dot));
  const om = Math.acos(dot), so = Math.sin(om);
  const coords = [];
  let prevLon = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let x, y, z;
    if (so < 1e-9) { x = v1[0]; y = v1[1]; z = v1[2]; }
    else {
      const a = Math.sin((1 - t) * om) / so, b = Math.sin(t * om) / so;
      x = a * v1[0] + b * v2[0]; y = a * v1[1] + b * v2[1]; z = a * v1[2] + b * v2[2];
    }
    const lat = deg(Math.atan2(z, Math.hypot(x, y)));
    let lon = deg(Math.atan2(y, x));
    if (prevLon !== null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    coords.push([lon, lat]);
  }
  return { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} };
}

/* ---------------------------------------------------------------- bootstrap */
Promise.all([
  fetch("data/flows.json").then((r) => r.json()),
  fetch("data/country-centroids.json").then((r) => r.json()),
  fetch("data/flows-monthly.json").then((r) => r.json()).catch(() => null),
])
  .then(([flows, centroids, monthly]) => {
    FLOWS = flows;
    CENTROIDS = centroids;
    ORIGIN = centroids["China"] || [104.2, 35.9];
    if (monthly && monthly.series) {
      let mx = 1;
      for (const k in monthly.series) for (const v of monthly.series[k]) if (v > mx) mx = v;
      MONTHLY = { months: monthly.months, series: monthly.series, max: mx };
    }
    initCharts();      // charts work with or without a map token
    initScrollama();
    startCinematic();  // cold-open: veil lift + text punch-in (map arcs ignite separately)
    if (!TOKEN || !TOKEN.startsWith("pk.")) {
      document.getElementById("token-warn").style.display = "flex";
      return;          // no token: narrative + charts still work
    }
    initMap();
  })
  .catch((err) => {
    console.error("Failed to load data:", err);
    alert("Could not load data/flows.json — run this from a local server, e.g. `python -m http.server`.");
  });

/* --------------------------------------------------------------- geometry */
function buildArcFeatures() {
  const feats = [];
  for (const c of FLOWS.countries) {
    const dest = c.lonlat || CENTROIDS[c.name];
    if (!dest) continue; // no centroid -> skip (matches pandas behaviour)
    const line = greatCircleLine(ORIGIN, dest, 64);
    line.properties = {
      name: c.name,
      region: c.region,
      value: c.solar_last12 || 0,
      focus: FOCUS_COUNTRIES.includes(c.name),
      w: 0,
    };
    feats.push(line);
  }
  return fc(feats);
}

function buildPointFeatures() {
  const feats = [fpoint(ORIGIN, { name: "China", value: 0, origin: true })];
  for (const c of FLOWS.countries) {
    const dest = c.lonlat || CENTROIDS[c.name];
    if (!dest) continue;
    feats.push(
      fpoint(dest, {
        name: c.name,
        region: c.region,
        value: c.solar_last12 || 0,
        focus: FOCUS_COUNTRIES.includes(c.name),
      })
    );
  }
  return fc(feats);
}

// recompute normalised width `w` (0..1, sqrt-scaled) for the active step set
function applyWeights(stepIdx) {
  if (!ARC_FC) return;
  const f = STEPS[stepIdx].filter;
  const visible = ARC_FC.features.filter((ft) =>
    f === "all" || f === "dim" ? true : ft.properties.region === f
  );
  const max = Math.max(1, ...visible.map((ft) => ft.properties.value));
  for (const ft of ARC_FC.features) {
    const inSet = f === "all" || f === "dim" ? true : ft.properties.region === f;
    ft.properties.w = inSet ? Math.sqrt(ft.properties.value / max) : 0;
    ft.properties.inset = inSet ? 1 : 0;
  }
  if (MAP && MAP.getSource("arcs")) MAP.getSource("arcs").setData(ARC_FC);
}

// build moving particle positions for the current phase, along the active arcs only
function updateParticles(phase) {
  if (!ARC_FC || !MAP || !MAP.getSource("particles")) return;
  const K = 3; // particles per arc
  const feats = [];
  for (const arc of ARC_FC.features) {
    if (!(arc.properties.w > 0)) continue;
    const coords = arc.geometry.coordinates;
    const n = coords.length;
    for (let k = 0; k < K; k++) {
      const tt = (phase + k / K) % 1;
      const f = tt * (n - 1);
      const i0 = Math.floor(f), i1 = Math.min(n - 1, i0 + 1), fr = f - i0;
      const lon = coords[i0][0] + (coords[i1][0] - coords[i0][0]) * fr;
      const lat = coords[i0][1] + (coords[i1][1] - coords[i0][1]) * fr;
      feats.push(fpoint([lon, lat], { glow: 0.45 + 0.55 * Math.sin(tt * Math.PI) }));
    }
  }
  MAP.getSource("particles").setData(fc(feats));
}

// left padding so the map's focal point sits to the RIGHT of the text column
function mapPadding() {
  const mobile = window.innerWidth <= 680;
  return { left: mobile ? 0 : Math.min(window.innerWidth * 0.30, 340), top: 0, right: 0, bottom: 0 };
}

// the intro parks the globe in the top-right so it doesn't clash with the centred title
function introRestPadding() {
  const W = window.innerWidth, H = window.innerHeight;
  if (W <= 680) return { left: 0, top: 0, right: 0, bottom: Math.round(H * 0.48) };
  return { left: Math.round(W * 0.5), top: 0, right: 0, bottom: Math.round(H * 0.3) };
}
function easeToIntroRest(immediate) {
  if (!MAP) return;
  MAP.easeTo({
    center: [58, 24], zoom: 1.08,
    padding: introRestPadding(),
    duration: immediate ? 0 : 1600,
    easing: (t) => 1 - Math.pow(1 - t, 3),
    essential: true,
  });
}
// show the "how to interact" hint once, when the reader reaches the first panel
let dragHintShown = false;
function showDragHint() {
  if (dragHintShown) return;
  const hint = document.getElementById("drag-hint");
  if (!hint || window.matchMedia("(pointer: coarse)").matches) return;
  dragHintShown = true;
  hint.classList.add("show");
  setTimeout(() => hint.classList.remove("show"), 9000);
}
// reveal the legend the first time the reader reaches "The Fact"; hide it on the dim coda
function setLegend(filter) {
  const lg = document.getElementById("legend");
  if (!lg) return;
  if (filter === "dim") { lg.classList.remove("show"); return; }
  if (!lg.classList.contains("show")) {
    lg.classList.add("show");
    if (!lg.dataset.breathed) { lg.classList.add("lg-breath"); lg.dataset.breathed = "1"; }
  }
}

/* -------------------------------------------------------------------- map */
function initMap() {
  mapboxgl.accessToken = TOKEN;
  const introReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const PRE_ROLL = introReduce ? { center: STEPS[0].center, zoom: STEPS[0].zoom } : { center: [86, 8], zoom: 1.05 };
  MAP = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/dark-v11",
    center: PRE_ROLL.center,
    zoom: PRE_ROLL.zoom,
    projection: "globe",
    attributionControl: false,
    interactive: true,
    dragRotate: true,
  });

  // page scroll drives the story, so keep wheel-zoom off the map; allow drag to
  // reorient the globe on desktop. On touch devices keep drag off so the page scrolls.
  MAP.scrollZoom.disable();
  MAP.doubleClickZoom.disable();
  if (window.matchMedia("(pointer: coarse)").matches) {
    MAP.dragPan.disable();
    MAP.dragRotate.disable();
    MAP.touchZoomRotate.disable();
    if (MAP.touchPitch) MAP.touchPitch.disable();
  }

  // one-time "drag to spin" hint (desktop only; dismiss on first drag or after 6s)
  const hint = document.getElementById("drag-hint");
  if (hint && window.matchMedia("(pointer: coarse)").matches) {
    hint.style.display = "none";
  } else if (hint) {
    MAP.on("dragstart", () => hint.classList.remove("show"));
  }

  ARC_FC = buildArcFeatures();
  const POINT_FC = buildPointFeatures();

  MAP.on("style.load", () => {
    // atmospheric dark fog for the "trade winds" feel
    MAP.setFog({
      color: "rgb(8, 16, 30)",
      "high-color": "rgb(12, 22, 45)",
      "horizon-blend": 0.06,
      "space-color": "rgb(3, 6, 13)",
      "star-intensity": 0.5,
    });

    // hide the basemap's own labels so our country labels don't compete
    for (const lyr of MAP.getStyle().layers) {
      if (lyr.type === "symbol") MAP.setLayoutProperty(lyr.id, "visibility", "none");
    }

    MAP.addSource("arcs", { type: "geojson", data: ARC_FC });
    MAP.addSource("pts", { type: "geojson", data: POINT_FC });

    // soft outer glow (wide, blurred, low opacity)
    MAP.addLayer({
      id: "arcs-glow",
      type: "line",
      source: "arcs",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ACCENT,
        "line-blur": 6,
        "line-opacity": ["interpolate", ["linear"], ["get", "w"], 0, 0, 0.05, 0.18, 1, 0.42],
        "line-width": ["interpolate", ["linear"], ["get", "w"], 0, 0, 1, 22],
      },
    });

    // bright core line
    MAP.addLayer({
      id: "arcs-core",
      type: "line",
      source: "arcs",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["case", ["get", "focus"], ACCENT_HI, ACCENT],
        "line-opacity": ["interpolate", ["linear"], ["get", "w"], 0, 0, 0.05, 0.5, 1, 0.95],
        "line-width": ["interpolate", ["linear"], ["get", "w"], 0, 0, 1, 2.6],
      },
    });

    // flowing "energy" particles travelling China -> destinations along the arcs
    MAP.addSource("particles", { type: "geojson", data: fc([]) });
    MAP.addLayer({
      id: "particles",
      type: "circle",
      source: "particles",
      paint: {
        "circle-color": ACCENT_HI,
        "circle-radius": 2.2,
        "circle-blur": 0.6,
        "circle-opacity": ["get", "glow"],
      },
    });

    // every destination gets a gentle white pulse halo (like China, but smaller)
    MAP.addLayer({
      id: "pts-pulse",
      type: "circle",
      source: "pts",
      filter: ["!", ["get", "origin"]],
      paint: { "circle-color": ACCENT_HI, "circle-opacity": 0.0, "circle-radius": 4, "circle-blur": 0.7 },
    });

    // bright white core dot — uniform across all destinations + China
    MAP.addLayer({
      id: "pts-core",
      type: "circle",
      source: "pts",
      paint: {
        "circle-color": ACCENT_HI,
        "circle-radius": ["case", ["get", "origin"], 5, 2.4],
        "circle-blur": 0.4,
        "circle-opacity": ["case", ["get", "origin"], 0.95, 0.55],
      },
    });

    // origin halo (China — slightly larger pulse)
    MAP.addLayer({
      id: "origin-pulse",
      type: "circle",
      source: "pts",
      filter: ["get", "origin"],
      paint: { "circle-color": ACCENT_HI, "circle-opacity": 0.0, "circle-radius": 6, "circle-blur": 0.7 },
    });

    // generous transparent hover target so the small dots are easy to hit
    MAP.addLayer({
      id: "pts-hit",
      type: "circle",
      source: "pts",
      paint: { "circle-color": "#000", "circle-opacity": 0, "circle-radius": 12 },
    });

    // place-name labels by role: origin (always), focus = Africa step, mideast = Gulf step
    const labelFC = fc([
      fpoint(ORIGIN, { label: "China", role: "origin" }),
      ...FOCUS_COUNTRIES.filter((n) => CENTROIDS[n]).map((n) => fpoint(CENTROIDS[n], { label: dispName(n), role: "focus" })),
      ...MIDEAST_LABELS.filter((n) => CENTROIDS[n]).map((n) => fpoint(CENTROIDS[n], { label: dispName(n), role: "mideast" })),
    ]);
    MAP.addSource("labels", { type: "geojson", data: labelFC });

    const labelLayout = (size) => ({
      "text-field": ["get", "label"],
      "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"],
      "text-size": size,
      "text-transform": "uppercase",
      "text-letter-spacing": 0.1,
      "text-offset": [0, 1.4],
      "text-anchor": "top",
      "text-allow-overlap": true,
    });

    MAP.addLayer({
      id: "labels-origin",
      type: "symbol",
      source: "labels",
      filter: ["==", ["get", "role"], "origin"],
      layout: { ...labelLayout(15), "text-offset": [0, -1.5], "text-anchor": "bottom" },
      paint: { "text-color": ACCENT_HI, "text-halo-color": "#03060d", "text-halo-width": 2.2, "text-halo-blur": 0.4 },
    });
    MAP.addLayer({
      id: "labels-focus",
      type: "symbol",
      source: "labels",
      filter: ["==", ["get", "role"], "focus"],
      layout: { ...labelLayout(18), visibility: "none" },
      paint: { "text-color": "#ffffff", "text-halo-color": "#03060d", "text-halo-width": 2.6, "text-halo-blur": 0.4 },
    });
    MAP.addLayer({
      id: "labels-mideast",
      type: "symbol",
      source: "labels",
      filter: ["==", ["get", "role"], "mideast"],
      layout: { ...labelLayout(16), visibility: "none" },
      paint: { "text-color": "#ffffff", "text-halo-color": "#03060d", "text-halo-width": 2.6, "text-halo-blur": 0.4 },
    });

    // hover tooltips on destination dots
    const tip = document.getElementById("tooltip");
    if (tip) {
      MAP.on("mousemove", "pts-hit", (e) => {
        const f = e.features[0].properties;
        MAP.getCanvas().style.cursor = "pointer";
        if (f.origin === true || f.origin === "true") {
          tip.innerHTML = "<b>China</b><span>Export origin</span>";
        } else {
          const v = +f.value;
          const dollars = v >= 1000 ? "$" + (v / 1000).toFixed(1) + "B" : "$" + Math.round(v) + "M";
          const gw = v / 100;
          tip.innerHTML = "<b>" + f.name + "</b><span>" + dollars + " solar &middot; ~" + (gw >= 1 ? gw.toFixed(1) : gw.toFixed(2)) + " GW (12 mo)</span>";
        }
        tip.style.left = e.point.x + "px";
        tip.style.top = e.point.y + "px";
        tip.classList.add("show");
      });
      MAP.on("mouseleave", "pts-hit", () => {
        MAP.getCanvas().style.cursor = "grab";
        tip.classList.remove("show");
      });
    }

    // make the globe read as draggable: a persistent grab cursor, grabbing on drag
    MAP.getCanvas().style.cursor = "grab";
    MAP.on("dragstart", () => { MAP.getCanvas().style.cursor = "grabbing"; });
    MAP.on("dragend", () => { MAP.getCanvas().style.cursor = "grab"; });

    const reduceMo = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (currentStep >= 0) {
      applyWeights(currentStep);
      gotoStep(currentStep, true);
    } else if (reduceMo) {
      applyWeights(0);
      easeToIntroRest(true);   // static globe parked top-right behind the intro
    } else {
      setupArcIgnition();      // cold open: ignite the arcs, settle the globe top-right
    }
    startAnimations();
  });
}

/* ------------------------------------------------------- cold-open intro */
// stagger the arcs so they "ignite" outward from China, then settle to step 0
function setupArcIgnition() {
  if (!ARC_FC) return;
  applyWeights(0);
  const ranked = ARC_FC.features
    .map((a) => {
      const c = a.geometry.coordinates;
      const d = c[c.length - 1];
      return { a, dist: Math.hypot(d[0] - ORIGIN[0], d[1] - ORIGIN[1]) };
    })
    .sort((p, q) => p.dist - q.dist);
  const N = ranked.length;
  ranked.forEach((o, i) => {
    o.a.properties.tw = o.a.properties.w;            // remember the target width
    o.a.properties.delay = N > 1 ? (i / (N - 1)) * 0.7 : 0;
    o.a.properties.w = 0;                            // start hidden
  });
  if (MAP.getSource("arcs")) MAP.getSource("arcs").setData(ARC_FC);
  INTRO.active = true;
  INTRO.start = performance.now();
  const ENTRANCE = 3800;
  MAP.easeTo({
    center: [46, 18],
    zoom: 1.5,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },   // entrance plays out centred
    duration: ENTRANCE,
    easing: (t) => 1 - Math.pow(1 - t, 3),
    essential: true,
  });
  // sequence: entrance finishes -> park the globe top-right -> THEN the words appear
  setTimeout(() => {
    if (currentStep >= 0) { finishIntro(); return; }   // reader already scrolled in
    easeToIntroRest(false);                             // glide to the corner (~1600ms)
    setTimeout(finishIntro, 1500);                      // words + chrome once it parks
  }, ENTRANCE + 100);
}

// veil lift + text punch-in + chrome reveal; independent of the map so it also
// runs in the no-token fallback. Honours prefers-reduced-motion.
let introFinished = false;
// bring in the words + surrounding chrome; called AFTER the globe has parked top-right
function finishIntro() {
  if (introFinished) return;
  introFinished = true;
  const intro = document.querySelector(".intro");
  if (intro) intro.classList.add("reveal");            // words fade in
  document.documentElement.classList.remove("cine");   // titlebar / progress / etc. fade in
  const veil = document.getElementById("cinematic");
  if (veil) veil.classList.add("done");
}
function startCinematic() {
  const root = document.documentElement;
  const veil = document.getElementById("cinematic");
  const reduceMo = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasMap = !!TOKEN && TOKEN.startsWith("pk.") && !reduceMo;
  if (reduceMo || !root.classList.contains("cine")) { finishIntro(); return; }
  requestAnimationFrame(() => { if (veil) veil.classList.add("lift"); });
  // the words wait for the globe: the map sequence calls finishIntro() once it has
  // parked top-right. With no globe, reveal after the veil lifts. Always keep a failsafe.
  setTimeout(finishIntro, hasMap ? 7000 : 1500);
}

/* ----------------------------------------------------------- animations */
// single requestAnimationFrame loop drives dashes, point pulse and globe drift;
// pauses when the tab is hidden and honours prefers-reduced-motion.
function startAnimations() {
  let hidden = document.hidden;
  document.addEventListener("visibilitychange", () => { hidden = document.hidden; });
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let phase = 0;

  function frame(t) {
    if (!hidden && MAP && !reduce) {
      // cold-open: grow each arc in, staggered, then settle
      if (INTRO.active && ARC_FC) {
        const el = (performance.now() - INTRO.start) / 1000;
        const ip = Math.min(1, Math.max(0, (el - 0.8) / 2.4));
        const ez = (x) => 1 - Math.pow(1 - x, 2);
        for (const a of ARC_FC.features) {
          const local = Math.min(1, Math.max(0, (ip - a.properties.delay) / 0.25));
          a.properties.w = a.properties.tw * ez(local);
        }
        if (MAP.getSource("arcs")) MAP.getSource("arcs").setData(ARC_FC);
        if (el >= 3.4) { INTRO.active = false; applyWeights(currentStep < 0 ? 0 : currentStep); }
      }
      // flowing particles along the active arcs
      phase = (phase + 0.004) % 1;
      updateParticles(phase);
      // pulsing points
      const p = (Math.sin(t / 700) + 1) / 2;
      if (MAP.getLayer("pts-pulse")) {
        MAP.setPaintProperty("pts-pulse", "circle-radius", 2.5 + p * 7);
        MAP.setPaintProperty("pts-pulse", "circle-opacity", 0.2 * (1 - p));
      }
      if (MAP.getLayer("origin-pulse")) {
        MAP.setPaintProperty("origin-pulse", "circle-radius", 8 + p * 26);
        MAP.setPaintProperty("origin-pulse", "circle-opacity", 0.45 * (1 - p));
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* --------------------------------------------------------------- stepping */
function gotoStep(i, immediate) {
  const s = STEPS[i];
  cancelGulf();
  applyWeights(i);

  // the arc-width legend only makes sense while arcs are the story (steps 0–2)
  setLegend(s.filter);

  if (MAP) {
    // labels per step
    if (MAP.getLayer("labels-focus"))
      MAP.setLayoutProperty("labels-focus", "visibility", (i === 1 || i === 2) ? "visible" : "none");
    if (MAP.getLayer("labels-mideast"))
      MAP.setLayoutProperty("labels-mideast", "visibility", i === 3 ? "visible" : "none");

    // dots persist every step; the active-region destinations stay bright while the
    // rest fade to a faint background network (China/origin always brightest)
    // the Gulf step tells a "goes dark" story, so its destinations read dim, not bright
    const dark = s.filter === "Middle East";
    if (MAP.getLayer("pts-core")) {
      const f = s.filter;
      let op, rad;
      if (f === "all" || f === "dim") {
        // whole-world views: the full destination network is bright
        op = ["case", ["get", "origin"], 0.95, 0.8];
        rad = ["case", ["get", "origin"], 5, 2.8];
      } else if (dark) {
        // fading Gulf: active dots are muted (the decline is the point)
        op = ["case", ["get", "origin"], 0.95, ["case", ["==", ["get", "region"], f], 0.5, 0.12]];
        rad = ["case", ["get", "origin"], 5, ["case", ["==", ["get", "region"], f], 2.6, 1.8]];
      } else {
        op = ["case", ["get", "origin"], 0.95, ["case", ["==", ["get", "region"], f], 0.95, 0.18]];
        rad = ["case", ["get", "origin"], 5, ["case", ["==", ["get", "region"], f], 3.4, 2]];
      }
      MAP.setPaintProperty("pts-core", "circle-opacity", op);
      MAP.setPaintProperty("pts-core", "circle-radius", rad);
    }
    // pulse only the active-region destinations (calmer; none on the coda)
    if (MAP.getLayer("pts-pulse")) {
      const f = s.filter;
      const pf = (f === "all" || f === "dim") ? ["!", ["get", "origin"]]
        : ["all", ["!", ["get", "origin"]], ["==", ["get", "region"], f]];
      MAP.setFilter("pts-pulse", pf);
    }

    // arcs stay full-brightness on most steps; the Gulf step fades them to embers
    // so the visual matches the "goes dark" copy.
    if (MAP.getLayer("arcs-glow")) {
      MAP.setPaintProperty("arcs-glow", "line-opacity",
        ["interpolate", ["linear"], ["get", "w"], 0, 0, 0.05, dark ? 0.07 : 0.18, 1, dark ? 0.2 : 0.42]);
      MAP.setPaintProperty("arcs-core", "line-opacity",
        ["interpolate", ["linear"], ["get", "w"], 0, 0, 0.05, dark ? 0.22 : 0.5, 1, dark ? 0.45 : 0.95]);
    }

    MAP.flyTo({
      center: s.center,
      zoom: s.zoom,
      pitch: s.pitch,
      padding: mapPadding(),
      duration: immediate ? 0 : 2200,
      essential: true,
    });
  }
}

/* ---------------------------------------------------------- gulf blackout */
// On the Gulf step, the arcs + dots arrive at their former peak brightness, then
// flicker and die out to the dim "dark" state — power failing across the Gulf.
let gulfRAF = null;
function cancelGulf() {
  if (gulfRAF) { cancelAnimationFrame(gulfRAF); gulfRAF = null; }
}
function animateGulfBlackout() {
  if (!MAP || !MAP.getLayer("arcs-core")) return;
  cancelGulf();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const setArcs = (gMid, gHi, cMid, cHi) => {
    MAP.setPaintProperty("arcs-glow", "line-opacity",
      ["interpolate", ["linear"], ["get", "w"], 0, 0, 0.05, gMid, 1, gHi]);
    MAP.setPaintProperty("arcs-core", "line-opacity",
      ["interpolate", ["linear"], ["get", "w"], 0, 0, 0.05, cMid, 1, cHi]);
  };
  const setDots = (v) => {
    if (!MAP.getLayer("pts-core")) return;
    MAP.setPaintProperty("pts-core", "circle-opacity",
      ["case", ["get", "origin"], 0.95,
        ["case", ["==", ["get", "region"], "Middle East"], v, 0.12]]);
  };
  // bright (former peak) -> dark (settled) endpoints
  const B = { gMid: 0.42, gHi: 0.85, cMid: 0.62, cHi: 0.98, dot: 0.95 };
  const D = { gMid: 0.07, gHi: 0.20, cMid: 0.22, cHi: 0.45, dot: 0.50 };
  const settle = () => { setArcs(D.gMid, D.gHi, D.cMid, D.cHi); setDots(D.dot); };
  if (reduce) { settle(); return; }
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (x) => x * x;
  const DUR = 3400;                                 // slower, more ominous decay
  const start = performance.now();
  // start at full peak brightness
  setArcs(B.gMid, B.gHi, B.cMid, B.cHi); setDots(B.dot);
  function frame(now) {
    const p = Math.min(1, (now - start) / DUR);
    const fp = p < 0.28 ? 0 : (p - 0.28) / 0.72;   // hold bright, then a long slow fade
    const e = ease(fp);
    // harsh flicker dips to near-black as the power fails
    let flick = 1;
    for (const c of [0.30, 0.46, 0.60, 0.74, 0.87]) { if (Math.abs(fp - c) < 0.045) flick = 0.05; }
    setArcs(
      lerp(B.gMid, D.gMid, e) * flick, lerp(B.gHi, D.gHi, e) * flick,
      lerp(B.cMid, D.cMid, e) * flick, lerp(B.cHi, D.cHi, e) * flick
    );
    setDots(Math.max(0.04, lerp(B.dot, D.dot, e) * flick));
    if (p < 1) { gulfRAF = requestAnimationFrame(frame); }
    else { gulfRAF = null; settle(); }
  }
  gulfRAF = requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ timeline */
function fmtMonth(d) {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return M[+d.slice(5, 7) - 1] + " " + d.slice(0, 4);
}

let tlTimer = null;
let tlMonth = 0;
let flareTimer = null;

// size every arc by its value in month m (normalised across all months) so the
// March 2026 surge visibly swells and the Gulf fades
function setTimelineMonth(m) {
  if (!MONTHLY || !ARC_FC) return;
  tlMonth = m;
  for (const arc of ARC_FC.features) {
    const s = MONTHLY.series[arc.properties.name];
    const v = s ? s[m] : 0;
    arc.properties.w = Math.sqrt(Math.max(0, v) / MONTHLY.max);
  }
  if (MAP && MAP.getSource("arcs")) MAP.getSource("arcs").setData(ARC_FC);
  const spikeIdx = MONTHLY.months.indexOf("2026-03-01");
  const sm = document.querySelector("#tl-stamp .tl-stamp-month");
  if (sm) sm.textContent = fmtMonth(MONTHLY.months[m]);
  const stamp = document.getElementById("tl-stamp");
  if (stamp) stamp.classList.toggle("spike", m === spikeIdx);
  if (m === spikeIdx) flareArcs();
  drawScrubber();
  if (HOLD.active) updateHoldProgress(m);
}

// brief brightness pump on the arcs when the playhead hits the spike month
function flareArcs() {
  if (!MAP || !MAP.getLayer("arcs-glow")) return;
  MAP.setPaintProperty("arcs-glow", "line-opacity",
    ["interpolate", ["linear"], ["get", "w"], 0, 0, 0.05, 0.4, 1, 0.85]);
  clearTimeout(flareTimer);
  flareTimer = setTimeout(() => {
    if (MAP.getLayer("arcs-glow"))
      MAP.setPaintProperty("arcs-glow", "line-opacity",
        ["interpolate", ["linear"], ["get", "w"], 0, 0, 0.05, 0.18, 1, 0.42]);
  }, 1300);
}

// trend sparkline scrubber: total monthly solar exports, elapsed fill, March tick, playhead
function drawScrubber() {
  const cv = document.getElementById("tl-canvas");
  if (!cv || !MONTHLY) return;
  const data = (FLOWS.worldByCatMonthly && FLOWS.worldByCatMonthly["Solar PV"]) || [];
  if (!data.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 248, h = cv.clientHeight || 46;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const n = MONTHLY.months.length;
  const padX = 6, padT = 7, padB = 5;
  const max = Math.max(...data) * 1.12 || 1;
  const X = (i) => padX + (i / (n - 1)) * (w - 2 * padX);
  const Y = (v) => padT + (1 - v / max) * (h - padT - padB);
  // March 2026 reference tick
  const mi = MONTHLY.months.indexOf("2026-03-01");
  if (mi >= 0) {
    ctx.strokeStyle = "rgba(244,169,59,0.5)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(mi), padT - 3); ctx.lineTo(X(mi), h - padB); ctx.stroke();
    ctx.setLineDash([]);
  }
  // elapsed area fill up to current month
  ctx.beginPath(); ctx.moveTo(X(0), h - padB);
  for (let i = 0; i <= tlMonth; i++) ctx.lineTo(X(i), Y(data[i]));
  ctx.lineTo(X(tlMonth), h - padB); ctx.closePath();
  ctx.fillStyle = "rgba(47,230,214,0.2)"; ctx.fill();
  // full trend line
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = "rgba(122,240,230,0.5)"; ctx.lineWidth = 1.5; ctx.stroke();
  // playhead
  const px = X(tlMonth);
  ctx.strokeStyle = "#2fe6d6"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px, padT - 3); ctx.lineTo(px, h - padB); ctx.stroke();
  ctx.fillStyle = "#b6fdf3";
  ctx.beginPath(); ctx.arc(px, Y(data[tlMonth] || 0), 3.4, 0, 7); ctx.fill();
}

function tlPlay() {
  if (!MONTHLY) return;
  clearInterval(tlTimer);
  const btn = document.getElementById("tl-play");
  if (btn) btn.textContent = "❚❚";
  tlTimer = setInterval(() => setTimelineMonth((tlMonth + 1) % MONTHLY.months.length), 420);
}
function tlPause() {
  clearInterval(tlTimer);
  tlTimer = null;
  const btn = document.getElementById("tl-play");
  if (btn) btn.textContent = "►";
}
function tlEnter() {
  const el = document.getElementById("timeline");
  if (!MONTHLY || !el) return;
  el.classList.add("show");
  const stamp = document.getElementById("tl-stamp");
  if (stamp) stamp.classList.add("show");
  setTimelineMonth(0);
  tlPlay();
}
function tlLeave() {
  const el = document.getElementById("timeline");
  if (el) el.classList.remove("show");
  const stamp = document.getElementById("tl-stamp");
  if (stamp) { stamp.classList.remove("show"); stamp.classList.remove("spike"); }
  tlPause();
  clearHoldUI();
}

/* --------------------------------------------------- forced hold (timeline) */
// Soft "watch this" gate on the timeline step: forward scroll is paused until the
// 16 months play through once. Always escapable (Skip button + scroll-up allowed),
// and disabled under prefers-reduced-motion so no one gets trapped.
function engageHold() {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || HOLD.done || !MONTHLY) return;   // gate only once; never trap
  HOLD.active = true;
  const h = document.getElementById("hold");
  if (h) {
    h.classList.remove("done");
    const lbl = h.querySelector(".hold-label");
    if (lbl) lbl.textContent = "Watch the 16 months play out — March 2026 is coming";
    h.classList.add("show");
  }
  updateHoldProgress(tlMonth);
}
function updateHoldProgress(m) {
  if (!MONTHLY) return;
  const n = MONTHLY.months.length - 1;
  const fill = document.getElementById("hold-fill");
  if (fill) fill.style.width = Math.round((m / n) * 100) + "%";
  if (HOLD.active && m >= n) releaseHold(false);   // one full pass complete
}
function releaseHold(skip) {
  if (!HOLD.active && skip !== true) return;
  HOLD.active = false;
  HOLD.done = true;
  const h = document.getElementById("hold");
  if (h) {
    if (skip) {
      h.classList.remove("show", "done");
    } else {
      const lbl = h.querySelector(".hold-label");
      if (lbl) lbl.textContent = "✓ That's the story — scroll on";
      h.classList.add("done");
      setTimeout(() => { if (!HOLD.active) h.classList.remove("show", "done"); }, 1900);
    }
  }
  if (skip) {
    const outro = document.querySelector(".outro");
    if (outro) outro.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}
function clearHoldUI() {
  HOLD.active = false;
  const h = document.getElementById("hold");
  if (h) h.classList.remove("show", "done");
}
function initHoldGuards() {
  window.addEventListener("wheel", (e) => { if (HOLD.active && e.deltaY > 0) e.preventDefault(); }, { passive: false });
  window.addEventListener("touchstart", (e) => { if (e.touches && e.touches[0]) _holdTouchY = e.touches[0].clientY; }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (!HOLD.active || !e.touches || !e.touches[0]) return;
    if (_holdTouchY - e.touches[0].clientY > 0) e.preventDefault();   // dragging up = scrolling down
  }, { passive: false });
  window.addEventListener("keydown", (e) => {
    if (!HOLD.active) return;
    if (["ArrowDown", "PageDown", "End", " ", "Spacebar"].includes(e.key)) e.preventDefault();
  });
  const skip = document.getElementById("hold-skip");
  if (skip) skip.addEventListener("click", () => releaseHold(true));
}

function initScrollama() {
  const scroller = scrollama();
  initHoldGuards();

  // park the globe top-right again whenever the reader returns to the intro
  const introSec = document.querySelector(".intro");
  if (introSec && "IntersectionObserver" in window) {
    new IntersectionObserver((ents) => {
      for (const e of ents) {
        if (e.isIntersecting && e.intersectionRatio >= 0.55 && MAP && !INTRO.active && currentStep >= 0) {
          easeToIntroRest(false);
        }
      }
    }, { threshold: [0.55] }).observe(introSec);
  }
  const steps = document.querySelectorAll("#scrolly .step");
  const dots = document.querySelectorAll("#progress .dot");

  // click a progress dot to jump to that step
  dots.forEach((d) =>
    d.addEventListener("click", () => {
      const el = document.querySelector(`#scrolly .step[data-step="${d.dataset.go}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    })
  );

  const restart = document.getElementById("restart");
  if (restart) restart.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  // timeline controls
  const tlPlayBtn = document.getElementById("tl-play");
  if (tlPlayBtn) tlPlayBtn.addEventListener("click", () => (tlTimer ? tlPause() : tlPlay()));
  const tlCanvas = document.getElementById("tl-canvas");
  if (tlCanvas) {
    let dragging = false;
    const scrub = (clientX) => {
      if (!MONTHLY) return;
      const rect = tlCanvas.getBoundingClientRect();
      const padX = 6;
      let frac = (clientX - rect.left - padX) / (rect.width - 2 * padX);
      frac = Math.max(0, Math.min(1, frac));
      tlPause();
      setTimelineMonth(Math.round(frac * (MONTHLY.months.length - 1)));
    };
    tlCanvas.addEventListener("pointerdown", (e) => { dragging = true; tlCanvas.setPointerCapture(e.pointerId); scrub(e.clientX); });
    tlCanvas.addEventListener("pointermove", (e) => { if (dragging) scrub(e.clientX); });
    tlCanvas.addEventListener("pointerup", () => { dragging = false; });
    window.addEventListener("resize", () => { if (currentStep === 5) drawScrubber(); });
  }

  scroller
    .setup({ step: "#scrolly .step", offset: 0.62, progress: false })
    .onStepEnter((res) => {
      steps.forEach((el) => el.classList.toggle("is-active", el === res.element));
      const i = +res.element.dataset.step;
      currentStep = i;
      dots.forEach((d) => d.classList.toggle("active", +d.dataset.go === i));
      gotoStep(i, false);
      if (i === 0) showDragHint();
      if (i === 1) drawHeroChart();
      if (i === 3) { drawMeChart(); animateGulfBlackout(); }
      if (i === 4) drawCodaChart();
      if (i === 5) { tlEnter(); engageHold(); } else tlLeave();
    })
    .onStepExit((res) => {
      // leaving the timeline step (e.g. scrolling on to the outro) stops playback
      if (+res.element.dataset.step === 5) tlLeave();
    });
  window.addEventListener("resize", scroller.resize);
}

/* ------------------------------------------------------------------ charts */
function initCharts() {
  window.addEventListener("resize", () => {
    if (currentStep === 1) drawHeroChart();
    if (currentStep === 3) drawMeChart();
    if (currentStep === 4) drawCodaChart();
  });
}

function prepCanvas(id) {
  const cv = document.getElementById(id);
  if (!cv) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 340;
  const h = cv.clientHeight || 160;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

// "nice" axis rounding so gridline labels land on clean numbers
function niceNum(x) {
  const exp = Math.floor(Math.log10(x || 1));
  const f = x / Math.pow(10, exp);
  const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return nf * Math.pow(10, exp);
}
// y tick label: 9000 -> "$9k", 250 -> "$250" (units stated in the chart header)
function fmtAxis(v) {
  if (v >= 1000) { const k = v / 1000; return "$" + (Number.isInteger(k) ? k : k.toFixed(1)) + "k"; }
  return "$" + Math.round(v);
}
function shortMonth(m) {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return M[+String(m).slice(5, 7) - 1] + " '" + String(m).slice(2, 4);
}

function drawLineChart(id, series, months, opts) {
  opts = opts || {};
  const c = prepCanvas(id);
  if (!c) return;
  const { ctx, w, h } = c;
  const padL = 38, padR = 10, padT = opts.peak ? 26 : opts.month ? 30 : 12, padB = 22;
  const all = series.flatMap((s) => s.data);
  const rawMax = Math.max(1, ...all);
  const step = niceNum(rawMax / 4);
  const max = Math.ceil(rawMax / step) * step; // nice axis top
  const n = months.length;
  const x = (i) => padL + (i / (n - 1)) * (w - padL - padR);
  const y = (v) => padT + (1 - v / max) * (h - padT - padB);

  // horizontal gridlines + y-axis value labels
  ctx.font = "9px Inter, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let v = 0; v <= max + 1e-6; v += step) {
    const gy = y(v);
    ctx.strokeStyle = v === 0 ? "rgba(139,160,189,0.3)" : "rgba(139,160,189,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
    ctx.fillStyle = "rgba(170,184,207,0.85)";
    ctx.fillText(fmtAxis(v), padL - 5, gy);
  }
  ctx.textBaseline = "alphabetic";

  // optional vertical annotation marker (e.g. the Apr-1 export deadline)
  if (opts.month) {
    const mi = months.findIndex((m) => String(m).slice(0, 7) === opts.month);
    if (mi >= 0) {
      const mx = x(mi);
      ctx.save();
      ctx.strokeStyle = "rgba(230,238,247,0.45)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(mx, padT); ctx.lineTo(mx, h - padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(230,238,247,0.78)";
      ctx.font = "9px Inter, sans-serif";
      const lines = String(opts.label || "").split("\n");
      const flip = mx > w - 70;
      ctx.textAlign = flip ? "right" : "left";
      const lx = flip ? mx - 4 : mx + 4;
      lines.forEach((ln, li) => ctx.fillText(ln, lx, 11 + li * 11));   // sit in the top margin, clear of the spike
      ctx.restore();
    }
  }

  // x-axis month labels: first and last
  ctx.fillStyle = "rgba(170,184,207,0.9)";
  ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "left"; ctx.fillText(shortMonth(months[0]), padL, h - 6);
  ctx.textAlign = "right"; ctx.fillText(shortMonth(months[n - 1]), w - padR, h - 6);

  for (const s of series) {
    if (s.fill) {
      ctx.beginPath();
      ctx.moveTo(x(0), h - padB);
      s.data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
      ctx.lineTo(x(n - 1), h - padB);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, padT, 0, h - padB);
      g.addColorStop(0, s.color + "55");
      g.addColorStop(1, s.color + "00");
      ctx.fillStyle = g; ctx.fill();
    }
    ctx.beginPath();
    s.data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.fill ? 2.6 : 2;
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
    const li = s.data.length - 1;
    ctx.fillStyle = s.color;
    ctx.beginPath(); ctx.arc(x(li), y(s.data[li]), 2.6, 0, 7); ctx.fill();
  }

  // peak callout: ring the max point of the first series and label its value
  if (opts.peak && series[0]) {
    const d = series[0].data;
    let pi = 0; for (let i = 1; i < d.length; i++) if (d[i] > d[pi]) pi = i;
    const px = x(pi), py = y(d[pi]);
    ctx.strokeStyle = ACCENT_HI; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 5, 0, 7); ctx.stroke();
    ctx.fillStyle = ACCENT_HI;
    ctx.beginPath(); ctx.arc(px, py, 2.4, 0, 7); ctx.fill();
    ctx.font = "bold 13px Inter, sans-serif";
    ctx.textAlign = px > w - 70 ? "right" : "center";
    ctx.fillStyle = "#ffffff";
    ctx.fillText("$" + Math.round(d[pi]) + "M", px, py - 12);
    ctx.font = "9px Inter, sans-serif";
    ctx.fillStyle = "rgba(170,184,207,0.95)";
    ctx.fillText(shortMonth(months[pi]), px, py - 26);
  }
}

// big hero chart: the Africa solar spike, the climax of the story
function drawHeroChart() {
  const r = FLOWS.regionsSolarMonthly || {};
  drawLineChart("hero-chart", [
    { data: r["Africa"] || [], color: "#f4a93b", fill: true },
  ], FLOWS.months, { peak: true });
}

function drawMeChart() {
  const r = FLOWS.regionsSolarMonthly || {};
  drawLineChart("me-chart", [
    { data: r["Middle East"] || [], color: "#2fe6d6" },
    { data: r["Africa"] || [], color: "#f4a93b" },
  ], FLOWS.months, { month: "2026-04", label: "Apr 1:\ntax break ends" });
}

function drawCodaChart() {
  const wbc = FLOWS.worldByCatMonthly || {};
  drawLineChart("coda-chart", [
    { data: wbc["Solar PV"] || [], color: "#2fe6d6" },
    { data: wbc["Batteries"] || [], color: "#9b8cff" },
    { data: wbc["EVs"] || [], color: "#f4a93b" },
  ], FLOWS.months);
}

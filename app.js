/* ============================================================================
   China's Clean Tech Exports — scrollytelling flow map
   Mapbox GL JS + Scrollama.  Data: Ember (CC-BY-4.0).
   ----------------------------------------------------------------------------
   PASTE YOUR MAPBOX TOKEN BELOW (public token, starts with "pk.").
   Get a free one at https://account.mapbox.com/access-tokens/
============================================================================ */
const MAPBOX_TOKEN = "pk.eyJ1IjoiY2hyaXN0aW5lcC0iLCJhIjoiY21wbXQ2OW5oMDNuMDJyczg4OW1tdndrbyJ9.nms2zbOixP3ZS30hWMmSYQ";

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
  { center: [42, 18], zoom: 1.35, pitch: 0,  filter: "all",         label: "global" },
  { center: [21, 4],  zoom: 2.45, pitch: 15, filter: "Africa",      label: "africa" },
  { center: [26, 7],  zoom: 2.15, pitch: 10, filter: "Africa",      label: "drivers" },
  { center: [49, 26], zoom: 3.0,  pitch: 20, filter: "Middle East", label: "mideast" },
  { center: [70, 16], zoom: 1.45, pitch: 0,  filter: "dim",         label: "coda" },
  { center: [55, 18], zoom: 1.4,  pitch: 0,  filter: "all",         label: "timeline" },
];

let MAP, FLOWS, CENTROIDS, ORIGIN, ARC_FC, MONTHLY;
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
  return { left: mobile ? 0 : Math.min(window.innerWidth * 0.42, 460), top: 0, right: 0, bottom: 0 };
}

/* -------------------------------------------------------------------- map */
function initMap() {
  mapboxgl.accessToken = TOKEN;
  MAP = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/dark-v11",
    center: STEPS[0].center,
    zoom: STEPS[0].zoom,
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
    const hideHint = () => hint.classList.add("hide");
    MAP.on("dragstart", hideHint);
    setTimeout(hideHint, 6000);
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
        MAP.getCanvas().style.cursor = "";
        tip.classList.remove("show");
      });
    }

    applyWeights(currentStep < 0 ? 0 : currentStep);
    if (currentStep >= 0) gotoStep(currentStep, true);
    startAnimations();
  });
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
  applyWeights(i);

  // the arc-width legend only makes sense while arcs are the story (steps 0–2)
  const legend = document.getElementById("legend");
  if (legend) legend.style.opacity = s.filter === "dim" ? "0" : "1";

  if (MAP) {
    // labels per step
    if (MAP.getLayer("labels-focus"))
      MAP.setLayoutProperty("labels-focus", "visibility", (i === 1 || i === 2) ? "visible" : "none");
    if (MAP.getLayer("labels-mideast"))
      MAP.setLayoutProperty("labels-mideast", "visibility", i === 3 ? "visible" : "none");

    // dots persist every step; the active-region destinations stay bright while the
    // rest fade to a faint background network (China/origin always brightest)
    if (MAP.getLayer("pts-core")) {
      const f = s.filter;
      let op, rad;
      if (f === "all" || f === "dim") {
        // whole-world views: the full destination network is bright
        op = ["case", ["get", "origin"], 0.95, 0.8];
        rad = ["case", ["get", "origin"], 5, 2.8];
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

    // arcs stay full-brightness on the global + coda steps; regional steps keep
    // the same bright treatment for the active region.
    if (MAP.getLayer("arcs-glow")) {
      MAP.setPaintProperty("arcs-glow", "line-opacity",
        ["interpolate", ["linear"], ["get", "w"], 0, 0, 0.05, 0.18, 1, 0.42]);
      MAP.setPaintProperty("arcs-core", "line-opacity",
        ["interpolate", ["linear"], ["get", "w"], 0, 0, 0.05, 0.5, 1, 0.95]);
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
  tlTimer = setInterval(() => setTimelineMonth((tlMonth + 1) % MONTHLY.months.length), 750);
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
}

function initScrollama() {
  const scroller = scrollama();
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
      if (i === 3) drawMeChart();
      if (i === 4) drawCodaChart();
      if (i === 5) tlEnter(); else tlLeave();
    });
  window.addEventListener("resize", scroller.resize);
}

/* ------------------------------------------------------------------ charts */
function initCharts() {
  window.addEventListener("resize", () => {
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

function drawLineChart(id, series, months, marker) {
  const c = prepCanvas(id);
  if (!c) return;
  const { ctx, w, h } = c;
  const padL = 6, padR = 6, padT = 10, padB = 18;
  const all = series.flatMap((s) => s.data);
  const max = Math.max(...all) * 1.08;
  const n = months.length;
  const x = (i) => padL + (i / (n - 1)) * (w - padL - padR);
  const y = (v) => padT + (1 - v / max) * (h - padT - padB);

  ctx.strokeStyle = "rgba(139,160,189,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, h - padB); ctx.lineTo(w - padR, h - padB); ctx.stroke();

  // optional vertical annotation marker (e.g. the Apr-1 export-rebate scrap).
  // fails gracefully: if the month isn't in the series, nothing is drawn.
  if (marker && marker.month) {
    const mi = months.findIndex((m) => String(m).slice(0, 7) === marker.month);
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
      const lines = String(marker.label || "").split("\n");
      // keep the label inside the canvas: flip to the left of the line near the edge
      const flip = mx > w - 70;
      ctx.textAlign = flip ? "right" : "left";
      const lx = flip ? mx - 4 : mx + 4;
      lines.forEach((ln, li) => ctx.fillText(ln, lx, padT + 9 + li * 10));
      ctx.restore();
    }
  }

  ctx.fillStyle = "rgba(170,184,207,0.9)";
  ctx.font = "10px Inter, sans-serif";
  const fmt = (m) => m.slice(0, 7);
  ctx.textAlign = "left"; ctx.fillText(fmt(months[0]), padL, h - 5);
  ctx.textAlign = "right"; ctx.fillText(fmt(months[n - 1]), w - padR, h - 5);

  for (const s of series) {
    ctx.beginPath();
    s.data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
    const li = s.data.length - 1;
    ctx.fillStyle = s.color;
    ctx.beginPath(); ctx.arc(x(li), y(s.data[li]), 2.6, 0, 7); ctx.fill();
  }
}

function drawMeChart() {
  const r = FLOWS.regionsSolarMonthly || {};
  drawLineChart("me-chart", [
    { data: r["Middle East"] || [], color: "#2fe6d6" },
    { data: r["Africa"] || [], color: "#f4a93b" },
  ], FLOWS.months, { month: "2026-03", label: "Apr 1: China scraps\nexport rebate" });
}

function drawCodaChart() {
  const wbc = FLOWS.worldByCatMonthly || {};
  drawLineChart("coda-chart", [
    { data: wbc["Solar PV"] || [], color: "#2fe6d6" },
    { data: wbc["Batteries"] || [], color: "#9b8cff" },
    { data: wbc["EVs"] || [], color: "#f4a93b" },
  ], FLOWS.months);
}

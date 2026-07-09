/* ============================================================================
   The Pull — Part 2 of "China's Clean Tech Exports"
   Four beats: hook · a day on the grid · the country explorer · the close.
   Vanilla JS + Mapbox GL. Data: Ember (CC-BY-4.0) + European Commission.
============================================================================ */
const MAPBOX_TOKEN = "pk.eyJ1IjoiY2hyaXN0aW5lcC0iLCJhIjoiY21xb3lrazJ0MDF5ZTJyc2dyMWljcTF6dSJ9.wlE8TS4YnDWJRqUCM9x3ZA";
const TOKEN =
  (typeof window !== "undefined" && window.MAPBOX_TOKEN) ||
  new URLSearchParams(location.search).get("token") ||
  MAPBOX_TOKEN;

const ACCENT = "#2fe6d6";
const ACCENT_HI = "#b6fdf3";
const AMBER = "#f4a93b";
const FOSSIL = "#8ba0bd";
const EVCOL = "#9b8cff";
const REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let EU = null, CARDS = null, CENTROIDS = null, ORIGIN = [104.2, 35.9];
let MAP = null, mapReady = false, selected = null;

/* --------------------------------------------------------- geojson helpers */
function fpoint(coords, props) { return { type: "Feature", geometry: { type: "Point", coordinates: coords }, properties: props || {} }; }
function fc(features) { return { type: "FeatureCollection", features }; }
function greatCircleLine(from, to, n = 64) {
  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  const [lo1, la1] = from, [lo2, la2] = to;
  const f1 = rad(la1), l1 = rad(lo1), f2 = rad(la2), l2 = rad(lo2);
  const v1 = [Math.cos(f1) * Math.cos(l1), Math.cos(f1) * Math.sin(l1), Math.sin(f1)];
  const v2 = [Math.cos(f2) * Math.cos(l2), Math.cos(f2) * Math.sin(l2), Math.sin(f2)];
  let dot = Math.max(-1, Math.min(1, v1[0]*v2[0]+v1[1]*v2[1]+v1[2]*v2[2]));
  const om = Math.acos(dot), so = Math.sin(om);
  const coords = []; let prevLon = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n; let x, y, z;
    if (so < 1e-9) { x = v1[0]; y = v1[1]; z = v1[2]; }
    else { const a = Math.sin((1-t)*om)/so, b = Math.sin(t*om)/so; x = a*v1[0]+b*v2[0]; y = a*v1[1]+b*v2[1]; z = a*v1[2]+b*v2[2]; }
    const lat = deg(Math.atan2(z, Math.hypot(x, y)));
    let lon = deg(Math.atan2(y, x));
    if (prevLon !== null) { while (lon - prevLon > 180) lon -= 360; while (lon - prevLon < -180) lon += 360; }
    prevLon = lon; coords.push([lon, lat]);
  }
  return { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} };
}

/* ---------------------------------------------------------------- format */
function fmtMoney(m) { if (m == null) return "—"; return m >= 1000 ? "$" + (m / 1000).toFixed(1) + "B" : "$" + Math.round(m) + "M"; }
function shortMonth(m) { const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return M[+String(m).slice(5,7)-1] + " '" + String(m).slice(2,4); }
function fmtHour(h) { const ap = h < 12 ? "AM" : "PM"; const hr = h % 12 === 0 ? 12 : h % 12; return hr + " " + ap; }

/* ---------------------------------------------------------------- bootstrap */
Promise.all([
  fetch("data/eu-electricity-mix.json").then((r) => r.json()).catch(() => null),
  fetch("data/eu-country-cards.json").then((r) => r.json()),
  fetch("data/country-centroids.json").then((r) => r.json()).catch(() => ({})),
])
  .then(([eu, cards, cen]) => {
    EU = eu; CARDS = cards; CENTROIDS = cen || {};
    ORIGIN = CENTROIDS["China"] || [104.2, 35.9];
    CARDS.countries.sort((a, b) => (b.battery12mo || 0) - (a.battery12mo || 0));
    initStars();
    initDayGrid();
    buildGrid();
    initMap();
    initReveal();
    setTimeout(revealHeroCopy, 4200); // failsafe so the headline always appears
    window.addEventListener("resize", () => { drawDay(dgHour); redrawSparks(); if (selected) redrawPanelChart(); });
  })
  .catch((err) => { console.error("Failed to load data:", err); alert("Could not load data — run this from a local server, e.g. `python -m http.server`."); });

/* ------------------------------------------------- reveal-on-scroll (subtle) */
function initReveal() {
  const els = document.querySelectorAll(".d-reveal");
  if (REDUCE || !("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
  const io = new IntersectionObserver((ents) => {
    ents.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
  }, { threshold: 0.15 });
  els.forEach((e) => io.observe(e));
}

/* ============================================================================
   BEAT 2 — "A day on Europe's grid" (illustrative clear-summer-day shape)
============================================================================ */
// 24 hourly points. Units are relative (a stylised day), so the chart shows the
// SHAPE — solar bell vs. evening demand peak — not measured gigawatts.
const SOLAR  = [0,0,0,0,0,12, 55,120,205,300, 380,415,420,405,352,278, 188,98,34,6, 0,0,0,0];
const DEMAND = [282,268,258,252,256,276, 306,346,368,378, 372,360,352,348,350,360, 380,412,442,452, 430,392,342,300];
const SOC    = [12,10,8,6,6,7, 9,11,15,27, 46,66,84,93,95,88, 74,56,38,20, 12,11,11,11]; // battery charge %
const DAY_MAX = 480;
let dgHour = 12, dgTimer = null;

function initDayGrid() {
  const slider = document.getElementById("dg-slider");
  const play = document.getElementById("dg-play");
  const canvas = document.getElementById("dg-canvas");
  if (!slider) return;
  slider.addEventListener("input", () => { stopDay(); setHour(+slider.value); });
  if (play) play.addEventListener("click", toggleDay);
  if (canvas) canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const padL = 34, padR = 14;
    let frac = (e.clientX - r.left - padL) / (r.width - padL - padR);
    frac = Math.max(0, Math.min(1, frac));
    stopDay(); setHour(Math.round(frac * 23));
  });
  setHour(12);
  // gently autoplay once when it first scrolls into view, so the motion invites interaction
  if (!REDUCE && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((ents) => {
      ents.forEach((e) => { if (e.isIntersecting) { io.disconnect(); setHour(0); playDay(); } });
    }, { threshold: 0.5 });
    io.observe(document.getElementById("daygrid"));
  }
}
function setHour(h) {
  dgHour = Math.max(0, Math.min(23, h));
  const slider = document.getElementById("dg-slider"); if (slider) slider.value = dgHour;
  const time = document.getElementById("dg-time"); if (time) time.textContent = fmtHour(dgHour);
  updateGauge(dgHour);
  updateNarr(dgHour);
  drawDay(dgHour);
}
function playDay() {
  const play = document.getElementById("dg-play"); if (play) play.innerHTML = "&#10073;&#10073;";
  clearInterval(dgTimer);
  dgTimer = setInterval(() => { if (dgHour >= 23) { stopDay(); } else setHour(dgHour + 1); }, 300);
}
function stopDay() { clearInterval(dgTimer); dgTimer = null; const play = document.getElementById("dg-play"); if (play) play.innerHTML = "&#9654;"; }
function toggleDay() { if (dgTimer) stopDay(); else { if (dgHour >= 23) setHour(0); playDay(); } }

function chargeState(h) {
  if (h <= 0) return "idle";
  const d = SOC[h] - SOC[h - 1];
  if (d > 1) return "charging";
  if (d < -1) return "discharging";
  return "idle";
}
function updateGauge(h) {
  const fill = document.getElementById("dg-batt-fill");
  const pct = document.getElementById("dg-batt-pct");
  const state = document.getElementById("dg-batt-state");
  const batt = document.querySelector(".dg-batt");
  if (!fill) return;
  const st = chargeState(h);
  fill.style.height = SOC[h] + "%";
  fill.style.background = st === "discharging"
    ? "linear-gradient(180deg,#ffd089,#f4a93b)"
    : "linear-gradient(180deg,#b6fdf3,#2fe6d6)";
  if (pct) pct.textContent = SOC[h] + "%";
  if (state) state.textContent = st === "charging" ? "Charging" : st === "discharging" ? "Discharging" : "Holding";
  if (batt) batt.classList.toggle("is-charging", st === "charging");
}
function updateNarr(h) {
  const el = document.getElementById("dg-narr"); if (!el) return;
  let t;
  if (h <= 5) t = "<b>Night.</b> Not much power is used, and there is no sun.";
  else if (h <= 9) t = "<b>Morning.</b> People wake up and use more power. Solar is just starting.";
  else if (h <= 14) t = "<b>Midday.</b> Solar makes more than people need. The <span style='color:#2fe6d6'>extra sun</span> charges the batteries.";
  else if (h <= 16) t = "<b>Afternoon.</b> Solar drops fast, but power use keeps climbing.";
  else if (h <= 21) t = "<b>Evening.</b> The sun is gone but everyone is home using power. Batteries give back the midday sun, so <span style='color:#f4a93b'>gas plants</span> can stay off.";
  else t = "<b>Late night.</b> The batteries are empty, power use falls, and the day starts over.";
  el.innerHTML = t;
}

function drawDay(hour) {
  const cv = document.getElementById("dg-canvas");
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600, h = cv.clientHeight || 300;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const padL = 34, padR = 14, padT = 18, padB = 26;
  const n = 24;
  const X = (i) => padL + (i / (n - 1)) * (w - padL - padR);
  const Y = (v) => padT + (1 - v / DAY_MAX) * (h - padT - padB);

  // faint horizontal gridlines (no fabricated numbers — the shape is the point)
  ctx.strokeStyle = "rgba(139,160,189,0.10)"; ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) { const gy = padT + (g / 4) * (h - padT - padB); ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke(); }

  // hour labels
  ctx.fillStyle = "rgba(170,184,207,0.8)"; ctx.font = "10px Inter, sans-serif"; ctx.textBaseline = "alphabetic";
  const ticks = [[0,"12a"],[6,"6a"],[12,"12p"],[18,"6p"],[23,"11p"]];
  ticks.forEach(([i, lab], k) => { ctx.textAlign = k === 0 ? "left" : k === ticks.length - 1 ? "right" : "center"; ctx.fillText(lab, X(i), h - 8); });

  const areaTo = (arr, col0, col1) => {
    ctx.beginPath(); ctx.moveTo(X(0), Y(0));
    arr.forEach((v, i) => ctx.lineTo(X(i), Y(v))); ctx.lineTo(X(n - 1), Y(0)); ctx.closePath();
    const g = ctx.createLinearGradient(0, padT, 0, h - padB); g.addColorStop(0, col0); g.addColorStop(1, col1); ctx.fillStyle = g; ctx.fill();
  };
  // demand area (amber) sits behind; where it shows above solar = the gap fossil must fill
  areaTo(DEMAND, "rgba(244,169,59,0.20)", "rgba(244,169,59,0.02)");
  // solar area (teal) on top; where it rises above demand (midday) = surplus
  areaTo(SOLAR, "rgba(47,230,214,0.34)", "rgba(47,230,214,0.03)");

  const line = (arr, col, wd) => { ctx.beginPath(); arr.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))); ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.shadowColor = col; ctx.shadowBlur = 4; ctx.stroke(); ctx.shadowBlur = 0; };
  line(DEMAND, AMBER, 2);
  line(SOLAR, ACCENT, 2.6);

  // playhead + markers at the current hour
  const hx = X(hour);
  ctx.strokeStyle = "rgba(230,238,247,0.55)"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(hx, padT - 4); ctx.lineTo(hx, h - padB); ctx.stroke(); ctx.setLineDash([]);
  const dot = (v, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(hx, Y(v), 4, 0, 7); ctx.fill(); ctx.strokeStyle = "#04121a"; ctx.lineWidth = 1.5; ctx.stroke(); };
  dot(DEMAND[hour], AMBER); dot(SOLAR[hour], ACCENT);

  // fixed labels so the chart explains itself at a glance
  ctx.textAlign = "center"; ctx.font = "bold 12px Inter, sans-serif";
  ctx.fillStyle = ACCENT; ctx.fillText("Solar", X(12), Y(SOLAR[12]) - 12);
  ctx.fillStyle = AMBER; ctx.fillText("Power use", X(19), Y(DEMAND[19]) - 12);
  ctx.font = "600 10px Inter, sans-serif";
  ctx.fillStyle = "rgba(47,230,214,0.95)"; ctx.fillText("extra sun", X(12), (Y(SOLAR[12]) + Y(DEMAND[12])) / 2 + 3);
  ctx.fillStyle = "rgba(244,169,59,0.95)"; ctx.fillText("the gap", X(19), (Y(SOLAR[19]) + Y(DEMAND[19])) / 2);
}

/* ============================================================================
   BEAT 3a — the country grid (axis-free sparklines)
============================================================================ */
function sparkId(name) { return "spark-" + name.replace(/[^a-z0-9]/gi, ""); }
function buildGrid() {
  const grid = document.getElementById("ex-grid");
  if (!grid || !CARDS) return;
  grid.innerHTML = CARDS.countries.map((c) => (
    '<button class="ex-card" type="button" data-country="' + c.name + '">' +
      '<span class="exc-top"><span class="exc-name">' + c.name + "</span>" +
        '<span class="exc-head">' + c.headline + "</span></span>" +
      '<span class="exc-val">' + fmtMoney(c.battery12mo) + '<em>batteries / yr</em></span>' +
      '<canvas class="exc-spark" id="' + sparkId(c.name) + '" aria-hidden="true"></canvas>' +
    "</button>"
  )).join("");
  grid.querySelectorAll(".ex-card").forEach((b) => b.addEventListener("click", () => selectCountry(b.dataset.country)));
  redrawSparks();
}
function drawSpark(canvasEl, data, color) {
  if (!canvasEl || !data || !data.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvasEl.clientWidth || 220, h = canvasEl.clientHeight || 40;
  canvasEl.width = w * dpr; canvasEl.height = h * dpr;
  const ctx = canvasEl.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const n = data.length, pad = 3, max = Math.max(...data) * 1.1 || 1;
  const X = (i) => pad + (i / (n - 1)) * (w - 2 * pad), Y = (v) => pad + (1 - v / max) * (h - 2 * pad);
  ctx.beginPath(); ctx.moveTo(X(0), h - pad); data.forEach((v, i) => ctx.lineTo(X(i), Y(v))); ctx.lineTo(X(n - 1), h - pad); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, color + "44"); g.addColorStop(1, color + "00"); ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); data.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))); ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
  const li = n - 1; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(li), Y(data[li]), 2.2, 0, 7); ctx.fill();
}
function redrawSparks() { if (!CARDS) return; for (const c of CARDS.countries) drawSpark(document.getElementById(sparkId(c.name)), c.batterySeries, ACCENT); }

/* ============================================================================
   BEAT 3b — the country panel (detail chart WITH x/y axes)
============================================================================ */
function niceNum(x) { const exp = Math.floor(Math.log10(x || 1)), f = x / Math.pow(10, exp); const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10; return nf * Math.pow(10, exp); }
function fmtAxisMoney(v) { return v >= 1000 ? "$" + (v / 1000).toFixed(1) + "B" : "$" + Math.round(v) + "M"; }

// full mini-chart with gridlines, $ y-axis and month x-axis (the "detailed" graph)
function drawAxisChart(id, series, months) {
  const cv = document.getElementById(id); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 340, h = cv.clientHeight || 170;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const padL = 46, padR = 12, padT = 14, padB = 24;
  const all = series.flatMap((s) => s.data); const rawMax = Math.max(1, ...all);
  const step = niceNum(rawMax / 3); const max = Math.ceil(rawMax / step) * step; const n = months.length;
  const X = (i) => padL + (i / (n - 1)) * (w - padL - padR), Y = (v) => padT + (1 - v / max) * (h - padT - padB);
  ctx.font = "9px Inter, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let v = 0; v <= max + 1e-6; v += step) {
    const gy = Y(v); ctx.strokeStyle = v === 0 ? "rgba(139,160,189,0.3)" : "rgba(139,160,189,0.12)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
    ctx.fillStyle = "rgba(170,184,207,0.85)"; ctx.fillText(fmtAxisMoney(v), padL - 5, gy);
  }
  ctx.textBaseline = "alphabetic"; ctx.fillStyle = "rgba(170,184,207,0.9)"; ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "left"; ctx.fillText(shortMonth(months[0]), padL, h - 6);
  ctx.textAlign = "right"; ctx.fillText(shortMonth(months[n - 1]), w - padR, h - 6);
  for (const s of series) {
    if (!s.data) continue;
    ctx.beginPath(); s.data.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.strokeStyle = s.color; ctx.lineWidth = 2.2; ctx.shadowColor = s.color; ctx.shadowBlur = 7; ctx.stroke(); ctx.shadowBlur = 0;
    const li = s.data.length - 1; ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(X(li), Y(s.data[li]), 2.6, 0, 7); ctx.fill();
  }
}
function redrawPanelChart() {
  const c = CARDS.countries.find((x) => x.name === selected); if (!c) return;
  const series = [{ data: c.batterySeries, color: ACCENT }];
  if (c.evSeries) series.push({ data: c.evSeries, color: EVCOL });
  drawAxisChart("cp-chart", series, CARDS.months);
}
function selectCountry(name) {
  const c = CARDS.countries.find((x) => x.name === name); if (!c) return;
  selected = name;
  const panel = document.getElementById("country-panel");
  const evVal = c.ev12mo != null
    ? '<span class="cp-m-val" style="color:' + EVCOL + '">' + fmtMoney(c.ev12mo) + "</span>"
    : '<span class="cp-m-note">not in top 30</span>';
  const evKey = c.ev12mo != null ? '<span class="key"><span class="swatch" style="background:' + EVCOL + '"></span> Electric cars</span>' : "";
  panel.innerHTML =
    '<button class="cp-close" type="button" aria-label="Close">×</button>' +
    '<p class="cp-eyebrow">' + c.headline + "</p>" +
    '<h3 class="cp-name">' + c.name + "</h3>" +
    '<p class="cp-milestone">' + c.milestone + "</p>" +
    '<div class="cp-nums">' +
      '<div class="cp-num"><span class="cp-m-label">Batteries / yr</span><span class="cp-m-val" style="color:' + ACCENT + '">' + fmtMoney(c.battery12mo) + "</span></div>" +
      '<div class="cp-num"><span class="cp-m-label">Electric cars / yr</span>' + evVal + "</div>" +
    "</div>" +
    '<canvas id="cp-chart" class="cp-chart" role="img" aria-label="Monthly Chinese battery and EV imports for ' + c.name + ', in US dollars."></canvas>' +
    '<div class="legend-row"><span class="key"><span class="swatch" style="background:' + ACCENT + '"></span> Batteries</span>' + evKey + "</div>" +
    '<p class="cp-foot">Chinese clean-tech imports · monthly · Jan 2025 – Apr 2026</p>';
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add("open"));
  redrawPanelChart();
  panel.querySelector(".cp-close").addEventListener("click", closePanel);
  document.querySelectorAll(".ex-card").forEach((b) => b.classList.toggle("active", b.dataset.country === name));
  if (MAP && MAP.getSource("pts")) MAP.getSource("pts").setData(buildPoints());
}
function closePanel() {
  const panel = document.getElementById("country-panel");
  if (panel) { panel.classList.remove("open"); setTimeout(() => { if (!panel.classList.contains("open")) panel.hidden = true; }, 300); }
  selected = null;
  document.querySelectorAll(".ex-card").forEach((b) => b.classList.remove("active"));
  if (MAP && MAP.getSource("pts")) MAP.getSource("pts").setData(buildPoints());
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && selected) closePanel(); });

/* -------------------------------------------------------------------- map */
function destOf(c) { return c.lonlat || CENTROIDS[c.name]; }
function buildArcs() {
  const feats = []; const max = Math.max(1, ...CARDS.countries.map((c) => c.battery12mo || 0));
  for (const c of CARDS.countries) { const d = destOf(c); if (!d) continue; const line = greatCircleLine(ORIGIN, d, 64); line.properties = { name: c.name, w: Math.sqrt((c.battery12mo || 0) / max) }; feats.push(line); }
  return fc(feats);
}
function buildPoints() {
  const feats = [fpoint(ORIGIN, { name: "China", origin: true, sel: false, val: 0 })];
  for (const c of CARDS.countries) { const d = destOf(c); if (!d) continue; feats.push(fpoint(d, { name: c.name, origin: false, sel: c.name === selected, val: c.battery12mo || 0 })); }
  return fc(feats);
}
function initMap() {
  if (mapReady) return;
  if (!TOKEN || !TOKEN.startsWith("pk.")) { document.getElementById("token-warn").style.display = "flex"; revealHeroCopy(); return; }
  mapReady = true; mapboxgl.accessToken = TOKEN;
  // start wide over Asia so the arcs ignite from China, then the camera flies to Europe
  const preRoll = REDUCE ? { center: [14, 49], zoom: 2.75, pitch: 12 } : { center: [92, 18], zoom: 1.12, pitch: 0 };
  MAP = new mapboxgl.Map({ container: "map", style: "mapbox://styles/mapbox/dark-v11", center: preRoll.center, zoom: preRoll.zoom, pitch: preRoll.pitch, projection: "globe", attributionControl: false, dragRotate: true });
  MAP.scrollZoom.disable(); MAP.doubleClickZoom.disable();
  // on touch devices, let the page scroll instead of grabbing the globe
  if (window.matchMedia("(pointer: coarse)").matches) { MAP.dragPan.disable(); MAP.dragRotate.disable(); if (MAP.touchZoomRotate) MAP.touchZoomRotate.disable(); }
  MAP.on("style.load", () => {
    MAP.setFog({ color: "rgb(8,16,30)", "high-color": "rgb(12,22,45)", "horizon-blend": 0.06, "space-color": "rgb(3,6,13)", "star-intensity": 0.5 });
    for (const lyr of MAP.getStyle().layers) if (lyr.type === "symbol") MAP.setLayoutProperty(lyr.id, "visibility", "none");
    // keep Europe clear of the overlaid hero copy (left on desktop, bottom on mobile)
    const mob = window.innerWidth <= 720;
    MAP.setPadding({ left: mob ? 0 : Math.min(window.innerWidth * 0.32, 380), right: 0, top: 0, bottom: mob ? Math.round(window.innerHeight * 0.4) : 40 });
    MAP.addSource("arcs", { type: "geojson", data: buildArcs() });
    MAP.addSource("pts", { type: "geojson", data: buildPoints(), generateId: true });
    MAP.addLayer({ id: "arcs-glow", type: "line", source: "arcs", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ACCENT, "line-blur": 6, "line-opacity": ["interpolate", ["linear"], ["get", "w"], 0, 0.06, 1, 0.42], "line-width": ["interpolate", ["linear"], ["get", "w"], 0, 1, 1, 20] } });
    MAP.addLayer({ id: "arcs-core", type: "line", source: "arcs", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ACCENT, "line-opacity": ["interpolate", ["linear"], ["get", "w"], 0, 0.35, 1, 0.9], "line-width": ["interpolate", ["linear"], ["get", "w"], 0, 0.6, 1, 2.6] } });
    MAP.addLayer({ id: "pts-halo", type: "circle", source: "pts", filter: ["!", ["get", "origin"]], paint: { "circle-color": ACCENT_HI, "circle-blur": 0.8,
      "circle-radius": ["case", ["boolean", ["feature-state", "hover"], false], 15, ["case", ["get", "sel"], 11, 7]],
      "circle-opacity": ["case", ["get", "sel"], 0.5, 0.22] } });
    MAP.addLayer({ id: "pts-core", type: "circle", source: "pts", paint: { "circle-color": ACCENT_HI, "circle-blur": 0.3,
      "circle-radius": ["case", ["get", "origin"], 5, ["case", ["boolean", ["feature-state", "hover"], false], 6.5, ["case", ["get", "sel"], 5, 3.4]]],
      "circle-opacity": ["case", ["get", "origin"], 0.95, 0.9] } });
    MAP.addLayer({ id: "pts-hit", type: "circle", source: "pts", filter: ["!", ["get", "origin"]], paint: { "circle-color": "#000", "circle-opacity": 0, "circle-radius": 16 } });
    const labelFC = fc([
      fpoint(ORIGIN, { label: "CHINA", name: "China", origin: true }),
      ...CARDS.countries.filter((c) => destOf(c)).map((c) => fpoint(destOf(c), { label: c.name.toUpperCase(), name: c.name, val: c.battery12mo || 0 })),
    ]);
    MAP.addSource("labels", { type: "geojson", data: labelFC, generateId: true });
    MAP.addLayer({ id: "labels", type: "symbol", source: "labels",
      layout: { "text-field": ["get", "label"], "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"], "text-size": 12, "text-transform": "uppercase", "text-letter-spacing": 0.08, "text-offset": [0, 1.2], "text-anchor": "top", "text-allow-overlap": false },
      paint: {
        "text-color": ["case", ["boolean", ["feature-state", "hover"], false], "#ffffff", "#cdd9e8"],
        "text-halo-color": ["case", ["boolean", ["feature-state", "hover"], false], "#0a3a3a", "#03060d"],
        "text-halo-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.8, 2.2], "text-halo-blur": 0.4 } });

    // hover glow + clickable names, so it's obvious the globe is interactive
    const tip = document.getElementById("map-tooltip");
    let hoverPt = null, hoverLbl = null;
    const clearPt = () => { if (hoverPt !== null) { MAP.setFeatureState({ source: "pts", id: hoverPt }, { hover: false }); hoverPt = null; } };
    const clearLbl = () => { if (hoverLbl !== null) { MAP.setFeatureState({ source: "labels", id: hoverLbl }, { hover: false }); hoverLbl = null; } };
    const showTip = (name, val, pt) => { tip.innerHTML = "<b>" + name + "</b><span>" + fmtMoney(+val) + " batteries. Click to open.</span>"; tip.style.left = pt.x + "px"; tip.style.top = pt.y + "px"; tip.classList.add("show"); };

    MAP.on("mousemove", "pts-hit", (e) => {
      MAP.getCanvas().style.cursor = "pointer";
      const f = e.features[0];
      if (hoverPt !== f.id) { clearPt(); hoverPt = f.id; MAP.setFeatureState({ source: "pts", id: hoverPt }, { hover: true }); }
      showTip(f.properties.name, f.properties.val, e.point);
    });
    MAP.on("mouseleave", "pts-hit", () => { MAP.getCanvas().style.cursor = "grab"; clearPt(); tip.classList.remove("show"); });
    MAP.on("click", "pts-hit", (e) => selectCountry(e.features[0].properties.name));

    MAP.on("mousemove", "labels", (e) => {
      const f = e.features[0];
      if (f.properties.name === "China") { MAP.getCanvas().style.cursor = ""; return; }
      MAP.getCanvas().style.cursor = "pointer";
      if (hoverLbl !== f.id) { clearLbl(); hoverLbl = f.id; MAP.setFeatureState({ source: "labels", id: hoverLbl }, { hover: true }); }
      showTip(f.properties.name, f.properties.val, e.point);
    });
    MAP.on("mouseleave", "labels", () => { MAP.getCanvas().style.cursor = "grab"; clearLbl(); tip.classList.remove("show"); });
    MAP.on("click", "labels", (e) => { const n = e.features[0].properties.name; if (n && n !== "China") selectCountry(n); });
    MAP.getCanvas().style.cursor = "grab";
    MAP.on("dragstart", () => { MAP.getCanvas().style.cursor = "grabbing"; });
    MAP.on("dragend", () => { MAP.getCanvas().style.cursor = "grab"; });
    startPulse();
    setTimeout(() => MAP.resize(), 60);
    runEntrance();
  });
}

/* cinematic entrance: arcs ignite from China, camera flies to Europe, copy fades in */
let heroRevealed = false;
function revealHeroCopy() { if (heroRevealed) return; heroRevealed = true; const c = document.querySelector(".d-hero-copy"); if (c) c.classList.add("in"); }
function runEntrance() {
  const target = { center: [14, 49], zoom: 2.75, pitch: 12, essential: true };
  if (REDUCE) { MAP.jumpTo(target); if (MAP.getSource("arcs")) MAP.getSource("arcs").setData(buildArcs()); revealHeroCopy(); return; }
  igniteArcs();
  MAP.flyTo({ ...target, duration: 3000, easing: (t) => 1 - Math.pow(1 - t, 3) });
  setTimeout(revealHeroCopy, 1700);
}
function igniteArcs() {
  const src = MAP.getSource("arcs"); if (!src) return;
  const data = buildArcs();
  const ranked = data.features
    .map((a) => { const c = a.geometry.coordinates; const d = c[c.length - 1]; return { a, dist: Math.hypot(d[0] - ORIGIN[0], d[1] - ORIGIN[1]) }; })
    .sort((p, q) => p.dist - q.dist);
  const N = ranked.length;
  ranked.forEach((o, i) => { o.a.properties.tw = o.a.properties.w; o.a.properties.delay = N > 1 ? (i / (N - 1)) * 0.65 : 0; o.a.properties.w = 0; });
  src.setData(data);
  const start = performance.now(), DUR = 2800;
  (function frame(now) {
    const el = (now - start) / 1000;
    const ip = Math.min(1, Math.max(0, (el - 0.3) / 2.0));
    const ez = (x) => 1 - Math.pow(1 - x, 2);
    for (const a of data.features) { const local = Math.min(1, Math.max(0, (ip - a.properties.delay) / 0.25)); a.properties.w = a.properties.tw * ez(local); }
    src.setData(data);
    if ((now - start) < DUR) requestAnimationFrame(frame); else src.setData(buildArcs());
  })(performance.now());
}

/* subtle drifting starfield behind the article (under the aurora) */
function initStars() {
  const cv = document.getElementById("d-stars"); if (!cv) return;
  const ctx = cv.getContext("2d"); const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0, H = 0, stars = [];
  function resize() {
    W = window.innerWidth; H = window.innerHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(220, Math.round((W * H) / 9000));
    stars = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.1 + 0.3, a: Math.random() * 0.5 + 0.18, ph: Math.random() * 6.28, sp: Math.random() * 0.6 + 0.2 }));
  }
  resize(); window.addEventListener("resize", resize);
  let hidden = document.hidden; document.addEventListener("visibilitychange", () => { hidden = document.hidden; });
  function render(t) {
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      if (!REDUCE) { s.y += 0.015; if (s.y > H) s.y = 0; }
      const a = REDUCE ? s.a : s.a * (0.6 + 0.4 * Math.sin(s.ph + t * 0.0012 * s.sp));
      ctx.globalAlpha = Math.max(0, a); ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 7); ctx.fillStyle = "#b6fdf3"; ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  if (REDUCE) { render(0); return; }
  (function loop(t) { if (!hidden) render(t); requestAnimationFrame(loop); })(0);
}
function startPulse() {
  let hidden = document.hidden;
  document.addEventListener("visibilitychange", () => { hidden = document.hidden; });
  function frame(t) {
    if (!hidden && !REDUCE && MAP && MAP.getLayer("pts-halo")) {
      const p = (Math.sin(t / 700) + 1) / 2;
      MAP.setPaintProperty("pts-halo", "circle-opacity", ["case", ["boolean", ["feature-state", "hover"], false], 0.6, ["case", ["get", "sel"], 0.55, 0.12 + 0.16 * (1 - p)]]);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
// The Pull — Part 2 script complete.

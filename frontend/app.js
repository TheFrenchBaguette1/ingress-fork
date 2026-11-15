"use strict";
/* Ingress front end.
 *
 * The server streams every exposure of the requested field once, resampled
 * onto one north-up grid. Everything after that (choosing a wavelength
 * range, grouping exposures into frames, zooming, stretching) happens here
 * in the browser on data already in memory, so switching is instant.
 */

const $ = (id) => document.getElementById(id);
const BAND_COLORS = { 1: "#6aa9ff", 2: "#5fd3c4", 3: "#9bd45a", 4: "#f2c94c", 5: "#f2994a", 6: "#eb5757" };
const ZOOM_STEPS = [1, 2, 3, 5, 10, 15, 20]; // arcmin
const PASS_GAP_DAYS = 30; // a longer pause in coverage starts a new survey pass
const PASS_MAX_DAYS = 45; // much longer continuous coverage is cut into frames about this long
const MJD_UNIX_EPOCH = 40587;
const DEFAULT_GROUP = "exposure"; // frame grouping used unless the URL says otherwise

let cfg = {
  fov: { min: 1, max: 20, default: 10 },
  date: { min: "2025-04-01", max: new Date().toISOString().slice(0, 10) },
  bands: { D1: [0.75, 1.11], D2: [1.1, 1.63], D3: [1.63, 2.42], D4: [2.42, 3.82], D5: [3.81, 4.42], D6: [4.41, 5.0] },
  flag_bits: {},
};

const state = {
  field: null, // description of the loaded field, from the server
  exposures: [], // [{meta, data: Float32Array}]
  failed: 0,
  loading: false,
  abort: null,
  band: "all", // "all", "D1".."D6" or "c:<min>-<max>"
  group: DEFAULT_GROUP,
  mode: "image",
  zoom: null, // arcmin shown
  frame: 0,
  playing: true,
  frames: [], // current animation
  cache: new Map(), // "<band>|<group>" -> frames
};

// ------------------------------------------------------------ utilities ---

const mjdToDate = (mjd) => new Date((mjd - MJD_UNIX_EPOCH) * 86400e3);
const fmtDate = (mjd) => mjdToDate(mjd).toISOString().slice(0, 10);
const fmtDateTime = (mjd) => mjdToDate(mjd).toISOString().slice(0, 16).replace("T", " ");

/** Parse "RA Dec" in decimal degrees or sexagesimal. Returns {ra, dec} in
 *  degrees or {error}. */
function parseCoords(text) {
  const raw = text.trim();
  if (!raw) return { error: "Enter a right ascension and declination." };
  const hasHourMark = /[h:]/i.test(raw);
  const clean = raw.replace(/[hmsd°′″'":,]/gi, " ").replace(/\s+/g, " ").replace(/([+-])\s+/g, "$1").trim();
  const tok = clean.split(" ");
  if (!tok.every((t) => /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t))) return { error: "Could not read those coordinates." };
  const v = tok.map(Number);
  const sex = (parts, signed) => {
    const neg = signed && parts[0].startsWith("-");
    const [a, b = 0, c = 0] = parts.map((p) => Math.abs(Number(p)));
    if (b >= 60 || c >= 60) return NaN;
    return (neg ? -1 : 1) * (a + b / 60 + c / 3600);
  };
  let ra, dec;
  if (tok.length === 2) {
    ra = hasHourMark ? v[0] * 15 : v[0];
    dec = v[1];
  } else if (tok.length === 6 || tok.length === 4) {
    const h = tok.length / 2;
    ra = sex(tok.slice(0, h), false) * 15;
    dec = sex(tok.slice(h), true);
  } else {
    return { error: "Give two values: right ascension, then declination." };
  }
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return { error: "Minutes and seconds must be below 60." };
  if (ra < 0 || ra >= 360) return { error: "Right ascension must be from 0 to 360° (0h to 24h)." };
  if (dec < -90 || dec > 90) return { error: "Declination must be from −90° to +90°." };
  return { ra, dec };
}

function fmtSexa(ra, dec) {
  const part = (x, d) => {
    const s = Math.abs(x) * 3600;
    const a = Math.floor(s / 3600), b = Math.floor((s % 3600) / 60), c = s % 60;
    return `${String(a).padStart(2, "0")} ${String(b).padStart(2, "0")} ${c.toFixed(d).padStart(d + 3, "0")}`;
  };
  return `${part(ra / 15, 2)}  ${dec < 0 ? "−" : "+"}${part(dec, 1)}`;
}

const EXP2 = Float64Array.from({ length: 32 }, (_, e) => 2 ** (e - 15));
function decodeFloat16(u16) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i], e = (h >> 10) & 31, f = h & 1023, s = h & 0x8000 ? -1 : 1;
    out[i] = e === 0 ? s * f * 5.960464477539063e-8 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * EXP2[e];
  }
  return out;
}

// ----------------------------------------------------------------- form ---

function validateForm() {
  const err = [];
  const c = parseCoords($("coords").value);
  $("coords").classList.toggle("invalid", !!c.error);
  if (c.error) err.push(c.error);

  const fov = Number($("fov").value);
  const fovOk = $("fov").value !== "" && fov >= cfg.fov.min && fov <= cfg.fov.max;
  $("fov").classList.toggle("invalid", !fovOk);
  if (!fovOk) err.push(`Field of view must be from ${cfg.fov.min} to ${cfg.fov.max} arcmin.`);

  const start = $("start").value, end = $("end").value;
  let dateErr = "";
  if (!start || !end) dateErr = "Choose both dates.";
  else if (start < cfg.date.min) dateErr = `The start date cannot be before ${cfg.date.min}.`;
  else if (end > cfg.date.max) dateErr = `The end date cannot be after today (${cfg.date.max}).`;
  else if (start >= end) dateErr = "The start date must be before the end date.";
  $("start").classList.toggle("invalid", !!dateErr);
  $("end").classList.toggle("invalid", !!dateErr);
  if (dateErr) err.push(dateErr);

  return err.length ? { error: err[0] } : { ra: c.ra, dec: c.dec, fov, start, end };
}

function showError(msg) {
  $("form-error").textContent = msg || "";
  $("form-error").hidden = !msg;
}

function echoCoords() {
  const c = parseCoords($("coords").value);
  $("coords-echo").textContent = c.error || !$("coords").value.trim() ? "" : `${fmtSexa(c.ra, c.dec)}   (${c.ra.toFixed(5)}°, ${c.dec.toFixed(5)}°)`;
}

// -------------------------------------------------------------- loading ---

async function load(q) {
  if (state.abort) state.abort.abort();
  const abort = (state.abort = new AbortController());
  Object.assign(state, { field: null, exposures: [], failed: 0, loading: true, frames: [], frame: 0, zoom: null });
  state.cache.clear();
  if (window.Measure) Measure.clear();
  showError("");
  $("progress").hidden = false;
  $("bar-fill").style.width = "0";
  $("progress-text").textContent = "Searching the SPHEREx archive…";
  $("empty").hidden = false;
  $("empty").textContent = "Searching the SPHEREx archive…";
  syncUrl(q);

  const params = new URLSearchParams({ ra: q.ra.toFixed(6), dec: q.dec.toFixed(6), fov: q.fov, start: q.start, end: q.end });
  try {
    const res = await fetch(`api/stream?${params}`, { signal: abort.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const d = body.detail;
      throw new Error(typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x.msg).join("; ") : `Server error ${res.status}`);
    }
    const reader = res.body.getReader();
    let buf = new Uint8Array(0), shown = 0, lastDone = 0, lastCost = 0;
    const text = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(buf.length + value.length);
      joined.set(buf);
      joined.set(value, buf.length);
      buf = joined;
      for (;;) {
        if (buf.length < 4) break;
        const hlen = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
        if (buf.length < 4 + hlen) break;
        const head = JSON.parse(text.decode(buf.subarray(4, 4 + hlen)));
        const end = 4 + hlen + head.nbytes;
        if (buf.length < end) break;
        handleRecord(head, buf.slice(4 + hlen, end));
        buf = buf.subarray(end);
      }
      // Refresh the animation as exposures arrive. The pause between
      // refreshes grows with their cost, so stacking modes stay responsive.
      if (state.exposures.length > shown && performance.now() - lastDone > Math.max(250, 5 * lastCost)) {
        shown = state.exposures.length;
        const t0 = performance.now();
        rebuild();
        lastDone = performance.now();
        lastCost = lastDone - t0;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    showError(e.message || "Loading failed.");
    $("empty").textContent = "Loading failed.";
  }
  if (state.abort !== abort) return;
  state.loading = false;
  $("progress").hidden = true;
  if (state.field && !state.exposures.length && $("form-error").hidden) {
    $("progress").hidden = true;
    $("empty").hidden = false;
    $("empty").textContent = "No SPHEREx images cover this position in that date range.";
  }
  state.cache.clear(); // frames built while loading are incomplete
  rebuild();
  precompute();
}

function handleRecord(head, payload) {
  if (head.type === "field") {
    state.field = head;
    state.zoom = head.fov_arcmin;
    buildZoomChips();
    if (!head.total) return;
    $("empty").textContent = `Loading ${head.total} exposures…`;
  } else if (head.type === "exposure") {
    const data = decodeFloat16(new Uint16Array(payload.buffer, payload.byteOffset, payload.byteLength / 2));
    state.exposures.push({ meta: head, data });
  } else if (head.type === "error") {
    state.failed++;
  } else if (head.type === "fatal") {
    showError(head.message);
    $("empty").textContent = "Loading failed.";
  }
  if (state.field && state.field.total) {
    const done = state.exposures.length + state.failed;
    $("bar-fill").style.width = `${(100 * done) / state.field.total}%`;
    $("progress-text").textContent = `Loaded ${done} of ${state.field.total} exposures`;
  }
}

// ------------------------------------------------------- frame building ---

function selected(band) {
  if (band === "all") return state.exposures;
  if (band.startsWith("c:")) {
    const [lo, hi] = band.slice(2).split("-").map(Number);
    return state.exposures.filter((e) => e.meta.wave >= lo && e.meta.wave <= hi);
  }
  const det = Number(band.slice(1));
  return state.exposures.filter((e) => e.meta.det === det);
}

/** Start times of the survey passes, found from every exposure loaded so
 *  that all wavelength ranges share the same frames. */
function passStarts() {
  const t = state.exposures.map((e) => e.meta.mjd).sort((a, b) => a - b);
  const runs = []; // [first, last] of each stretch of coverage without a long gap
  t.forEach((mjd, i) => {
    if (i === 0 || mjd - t[i - 1] > PASS_GAP_DAYS) runs.push([mjd, mjd]);
    else runs[runs.length - 1][1] = mjd;
  });
  // Fields near the ecliptic poles are observed continuously; cut such long
  // runs into equal pieces so they still animate.
  return runs.flatMap(([a, b]) => {
    const pieces = b - a > 2 * PASS_MAX_DAYS ? Math.ceil((b - a) / PASS_MAX_DAYS) : 1;
    return Array.from({ length: pieces }, (_, k) => a + (k * (b - a)) / pieces);
  });
}

function groupExposures(list, group) {
  const starts = group === "pass" ? passStarts() : null;
  const keyOf = (e) =>
    group === "exposure" ? e.meta.id : group === "day" ? Math.floor(e.meta.mjd) : starts.filter((s) => s <= e.meta.mjd).length;
  const groups = new Map();
  for (const e of [...list].sort((a, b) => a.meta.mjd - b.meta.mjd)) {
    const k = keyOf(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return [...groups.values()];
}

/** Average a group of exposures, ignoring pixels with no data. With five or
 *  more values, those far from the pixel's median (unflagged cosmic rays and
 *  hot pixels) are left out. */
function stack(list, npx) {
  if (list.length === 1) return list[0].data;
  const out = new Float32Array(npx), k = list.length;
  const vals = new Float32Array(k), dev = new Float32Array(k);
  for (let i = 0; i < npx; i++) {
    let c = 0, sum = 0;
    for (let e = 0; e < k; e++) {
      const v = list[e].data[i];
      if (v === v) { vals[c++] = v; sum += v; }
    }
    if (c < 5) { out[i] = c ? sum / c : NaN; continue; }
    const sorted = vals.subarray(0, c).sort();
    const med = sorted[c >> 1];
    for (let j = 0; j < c; j++) dev[j] = Math.abs(sorted[j] - med);
    const mad = dev.subarray(0, c).sort()[c >> 1];
    const limit = 6 * 1.4826 * mad;
    let n = 0;
    sum = 0;
    for (let j = 0; j < c; j++) if (Math.abs(sorted[j] - med) <= limit) { sum += sorted[j]; n++; }
    out[i] = n ? sum / n : med;
  }
  return out;
}

function buildFrames(band, group) {
  const npx = state.field.n * state.field.n;
  const frames = [];
  for (const g of groupExposures(selected(band), group)) {
    const img = stack(g, npx);
    let ok = 0;
    for (let i = 0; i < npx; i += 7) if (img[i] === img[i]) ok++;
    if (!ok) continue; // nothing usable in this group
    let flags = 0, wsum = 0;
    for (const e of g) { flags |= e.meta.flags; wsum += e.meta.wave; }
    frames.push({
      img, n: g.length, flags,
      t0: g[0].meta.mjd, t1: g[g.length - 1].meta.mjd,
      wmin: Math.min(...g.map((e) => e.meta.wave)), wmax: Math.max(...g.map((e) => e.meta.wave)),
      wave: wsum / g.length,
    });
  }
  // Average of all frames, for the difference view.
  const mean = stack(frames.map((f) => ({ data: f.img })), npx);
  for (const f of frames) f.mean = mean;
  return frames;
}

function framesFor(band, group) {
  const key = `${band}|${group}`;
  if (!state.cache.has(key)) state.cache.set(key, buildFrames(band, group));
  return state.cache.get(key);
}

/** Once everything has arrived, prepare every band in the background so
 *  that switching never has to wait. */
function precompute() {
  const todo = ["all", ...Object.keys(cfg.bands)].flatMap((b) => ["exposure", "day", "pass"].map((g) => [b, g]));
  const loadedFor = state.field;
  const step = () => {
    if (state.field !== loadedFor || state.loading || !todo.length) return;
    framesFor(...todo.shift());
    setTimeout(step, 0);
  };
  setTimeout(step, 50);
}

function rebuild() {
  if (!state.field || !state.exposures.length) { draw(); return; }
  if (state.loading) state.cache.clear(); // more exposures have arrived
  const keepTime = state.frames[state.frame] && state.frames[state.frame].t0;
  state.frames = framesFor(state.band, state.group);
  state.limits = null;
  // Stay on the same moment in time when the band changes.
  let idx = 0;
  if (keepTime != null) {
    let best = Infinity;
    state.frames.forEach((f, i) => { const d = Math.abs(f.t0 - keepTime); if (d < best) { best = d; idx = i; } });
  }
  state.frame = Math.min(idx, Math.max(0, state.frames.length - 1));
  const many = state.frames.length > 1;
  for (const id of ["play", "prev", "next", "frame"]) $(id).disabled = !many;
  $("frame").max = Math.max(0, state.frames.length - 1);
  $("empty").hidden = state.frames.length > 0;
  if (!state.frames.length) $("empty").textContent = "No exposures in this wavelength range.";
  $("compass").hidden = !state.frames.length;
  draw();
  drawTimeline();
  if (window.Measure) Measure.refresh();
}

// ------------------------------------------------------------ rendering ---

const off = document.createElement("canvas");

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] : 0;
}

/** Display range shared by all frames, so brightness changes are real. */
function limits() {
  const white = Number($("white").value) / 1000;
  const key = `${state.mode}|${white}|${state.zoom}`;
  if (state.limits && state.limits.key === key) return state.limits;
  const n = state.field.n, { x0, m } = crop();
  const a = Math.max(0, Math.floor(x0)), b = Math.min(n, Math.ceil(x0 + m));
  const total = state.frames.length * (b - a) * (b - a);
  const stride = Math.max(1, Math.floor(total / 150000));
  const vals = [];
  let k = 0;
  for (const f of state.frames) {
    for (let j = a; j < b; j++) for (let i = a; i < b; i++) {
      if (k++ % stride) continue;
      const v = state.mode === "diff" ? Math.abs(f.img[j * n + i] - f.mean[j * n + i]) : f.img[j * n + i];
      if (v === v) vals.push(v);
    }
  }
  const s = Float32Array.from(vals).sort();
  let lo, hi;
  if (state.mode === "diff") {
    hi = percentile(s, white) || 1e-6;
    lo = -hi;
  } else {
    const med = percentile(s, 0.5);
    const sigma = 1.4826 * percentile(Float32Array.from(s, (v) => Math.abs(v - med)).sort(), 0.5);
    lo = med - 2 * sigma;
    hi = Math.max(percentile(s, white), lo + 1e-6);
  }
  return (state.limits = { key, lo, hi });
}

function crop() {
  const n = state.field.n;
  const m = Math.min(n, (state.zoom * 60) / state.field.scale_arcsec);
  return { m, x0: (n - m) / 2 };
}

function draw() {
  const cv = $("view"), ctx = cv.getContext("2d");
  const size = Math.round(cv.clientWidth * (window.devicePixelRatio || 1)) || 640;
  if (cv.width !== size) cv.width = cv.height = size;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  const f = state.frames[state.frame];
  if (!f || !state.field) { $("frame-label").textContent = ""; $("info").textContent = ""; return; }

  const n = state.field.n, { lo, hi } = limits();
  const stretch = state.mode === "diff" ? "linear" : $("stretch").value;
  const invert = $("invert").checked, diff = state.mode === "diff";
  if (off.width !== n) off.width = off.height = n;
  const octx = off.getContext("2d");
  const im = octx.createImageData(n, n), px = im.data;
  const k = 1 / Math.asinh(10);
  for (let j = 0; j < n; j++) {
    const row = (n - 1 - j) * n * 4; // row 0 of the data is the south edge
    for (let i = 0; i < n; i++) {
      let v = f.img[j * n + i];
      if (diff) v -= f.mean[j * n + i];
      const o = row + i * 4;
      if (v !== v) { px[o] = 34; px[o + 1] = 24; px[o + 2] = 46; px[o + 3] = 255; continue; }
      let t = (v - lo) / (hi - lo);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (stretch === "sqrt") t = Math.sqrt(t);
      else if (stretch === "asinh") t = Math.asinh(10 * t) * k;
      if (invert) t = 1 - t;
      px[o] = px[o + 1] = px[o + 2] = 255 * t;
      px[o + 3] = 255;
    }
  }
  octx.putImageData(im, 0, 0);
  const { m, x0 } = crop();
  ctx.imageSmoothingEnabled = $("smooth").checked;
  ctx.drawImage(off, x0, x0, m, m, 0, 0, size, size);

  // Overlays.
  const u = size / 640;
  ctx.lineWidth = 1.5 * u;
  if ($("cross").checked) {
    ctx.strokeStyle = "rgba(242,180,65,0.9)";
    const c = size / 2, a = 10 * u, b = 28 * u;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(c + dx * a, c + dy * a);
      ctx.lineTo(c + dx * b, c + dy * b);
    }
    ctx.stroke();
  }
  const fovArcsec = state.zoom * 60;
  const bar = [300, 120, 60, 30, 20, 10, 5].find((s) => s <= fovArcsec / 4) || 5;
  const len = (bar / fovArcsec) * size;
  ctx.strokeStyle = ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(size - 14 * u - len, size - 16 * u);
  ctx.lineTo(size - 14 * u, size - 16 * u);
  ctx.stroke();
  ctx.font = `${12 * u}px system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.shadowColor = "#000";
  ctx.shadowBlur = 4 * u;
  ctx.fillText(bar >= 60 ? `${bar / 60}′` : `${bar}″`, size - 14 * u, size - 22 * u);
  ctx.shadowBlur = 0;
  if (window.Measure) Measure.overlay(ctx, (i, j) => [((i + 0.5 - x0) / m) * size, (1 - (j + 0.5 - x0) / m) * size], u);

  const when = f.t1 - f.t0 < 0.02 ? fmtDateTime(f.t0) + " UTC" : `${fmtDate(f.t0)} → ${fmtDate(f.t1)}`;
  $("frame-label").textContent = `${state.frame + 1}/${state.frames.length} · ${when}`;
  $("frame").value = state.frame;
  const flagNames = Object.entries(cfg.flag_bits).filter(([bit]) => f.flags & (1 << bit)).map(([, name]) => name);
  const fl = state.field;
  $("info").innerHTML =
    `<b>${state.exposures.length}</b> exposures loaded` +
    (fl.found > fl.total ? ` (a sample of ${fl.found} available; narrow the dates to see them all)` : "") +
    (state.failed ? `, ${state.failed} failed` : "") +
    (fl.complete === false ? " (part of the archive did not respond, so some exposures may be missing; reload to retry)" : "") +
    ` · this frame: <b>${f.n}</b> exposure${f.n > 1 ? "s" : ""}, ` +
    `<b>${f.wmin.toFixed(2)}${f.n > 1 ? "–" + f.wmax.toFixed(2) : ""} µm</b>` +
    ` · flags at centre: ${flagNames.length ? flagNames.join(", ") : "none"}`;
  drawTimelineCursor();
}

let timelineBase = null;
function drawTimeline() {
  const cv = $("timeline"), ctx = cv.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(cv.clientWidth * dpr) || 640;
  cv.height = Math.round(46 * dpr);
  ctx.clearRect(0, 0, cv.width, cv.height);
  timelineBase = null;
  if (!state.exposures.length) return;
  const t = state.exposures.map((e) => e.meta.mjd);
  const t0 = Math.min(...t) - 5, t1 = Math.max(...t) + 5;
  const X = (mjd) => ((mjd - t0) / (t1 - t0)) * cv.width;
  const inBand = new Set(selected(state.band));
  for (const e of state.exposures) {
    ctx.fillStyle = BAND_COLORS[e.meta.det];
    ctx.globalAlpha = inBand.has(e) ? 0.9 : 0.2;
    const h = 4 * dpr;
    ctx.fillRect(X(e.meta.mjd) - dpr, (4 + (e.meta.det - 1) * 4.6) * dpr, 2 * dpr, h);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#94a0b8";
  ctx.font = `${10 * dpr}px system-ui, sans-serif`;
  ctx.fillText(fmtDate(t0 + 5), 4 * dpr, cv.height - 4 * dpr);
  ctx.textAlign = "right";
  ctx.fillText(fmtDate(t1 - 5), cv.width - 4 * dpr, cv.height - 4 * dpr);
  ctx.textAlign = "left";
  timelineBase = { image: ctx.getImageData(0, 0, cv.width, cv.height), X, dpr };
  drawTimelineCursor();
}

function drawTimelineCursor() {
  const f = state.frames[state.frame];
  if (!timelineBase || !f) return;
  const cv = $("timeline"), ctx = cv.getContext("2d"), { X, dpr, image } = timelineBase;
  ctx.putImageData(image, 0, 0);
  const a = X(f.t0) - 3 * dpr, b = X(f.t1) + 3 * dpr;
  ctx.strokeStyle = "#f2b441";
  ctx.lineWidth = 1.5 * dpr;
  ctx.strokeRect(a, 1.5 * dpr, Math.max(b - a, 6 * dpr), 31 * dpr);
}

// ------------------------------------------------------------- controls ---

function buildBandChips() {
  const box = $("bands");
  box.textContent = "";
  const add = (key, label, sub) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.band = key;
    b.innerHTML = `${label}<small>${sub}</small>`;
    b.onclick = () => setBand(key);
    box.append(b);
  };
  add("all", "All", "0.75–5.0 µm");
  for (const [name, [lo, hi]] of Object.entries(cfg.bands)) add(name, `Band ${name.slice(1)}`, `${lo}–${hi} µm`);
  markChips();
}

function buildZoomChips() {
  const box = $("zooms");
  box.textContent = "";
  if (!state.field) return;
  const full = state.field.fov_arcmin;
  for (const z of [...ZOOM_STEPS.filter((s) => s < full), full]) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.zoom = z;
    b.textContent = `${z}′`;
    b.onclick = () => { state.zoom = z; state.limits = null; markChips(); draw(); syncUrl(); };
    box.append(b);
  }
  if (state.wantZoom && state.wantZoom < full) state.zoom = state.wantZoom;
  state.wantZoom = null;
  markChips();
}

function markChips() {
  for (const b of $("bands").children) b.classList.toggle("on", b.dataset.band === state.band);
  for (const b of $("zooms").children) b.classList.toggle("on", Number(b.dataset.zoom) === state.zoom);
}

function setBand(key) {
  state.band = key;
  markChips();
  rebuild();
  syncUrl();
}

function step(d) {
  if (!state.frames.length) return;
  state.frame = (state.frame + d + state.frames.length) % state.frames.length;
  draw();
}

let timer = null;
function tick() {
  clearTimeout(timer);
  if (state.playing && state.frames.length > 1) step(1);
  timer = setTimeout(tick, 1000 / Number($("speed").value));
}

function setPlaying(on) {
  state.playing = on;
  $("play").textContent = on ? "Pause" : "Play";
}

/** Sky position under the pointer (inverse gnomonic projection). */
function onHover(ev) {
  const f = state.frames[state.frame];
  if (!f) return;
  const r = $("view").getBoundingClientRect(), { m, x0 } = crop(), n = state.field.n;
  const i = x0 + ((ev.clientX - r.left) / r.width) * m - 0.5;
  const j = x0 + (1 - (ev.clientY - r.top) / r.height) * m - 0.5;
  const rad = Math.PI / 180, as = (state.field.scale_arcsec / 3600) * rad, c = (n - 1) / 2;
  const xi = -(i - c) * as, eta = (j - c) * as, d0 = state.field.dec * rad;
  const den = Math.cos(d0) - eta * Math.sin(d0);
  const dra = Math.atan2(xi, den);
  const dec = Math.atan(((Math.sin(d0) + eta * Math.cos(d0)) * Math.cos(dra)) / den) / rad;
  const ra = (((state.field.ra + dra / rad) % 360) + 360) % 360;
  const ii = Math.round(i), jj = Math.round(j);
  let v = ii >= 0 && jj >= 0 && ii < n && jj < n ? f.img[jj * n + ii] : NaN;
  if (state.mode === "diff" && v === v) v -= f.mean[jj * n + ii];
  $("readout").textContent = `${fmtSexa(ra, dec)}   ${v === v ? v.toFixed(3) + " MJy/sr" : "no data"}`;
}

// ------------------------------------------------------------------ URL ---

function syncUrl(q) {
  const cur = new URLSearchParams(location.search);
  const p = new URLSearchParams();
  const src = q || { ra: cur.get("ra"), dec: cur.get("dec"), fov: cur.get("fov"), start: cur.get("start"), end: cur.get("end") };
  if (src.ra == null) return;
  p.set("ra", Number(src.ra).toFixed(6));
  p.set("dec", Number(src.dec).toFixed(6));
  p.set("fov", src.fov);
  if (src.start) p.set("start", src.start);
  if (src.end) p.set("end", src.end);
  if (state.band !== "all") p.set("band", state.band);
  if (state.zoom && state.field && state.zoom !== state.field.fov_arcmin) p.set("zoom", state.zoom);
  if (state.group !== DEFAULT_GROUP) p.set("group", state.group);
  history.replaceState(null, "", `?${p}`);
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  const band = p.get("band");
  if (band && (band === "all" || cfg.bands[band] || /^c:[\d.]+-[\d.]+$/.test(band))) state.band = band;
  if (["pass", "day", "exposure"].includes(p.get("group"))) state.group = $("group").value = p.get("group");
  if (Number(p.get("zoom")) > 0) state.wantZoom = Number(p.get("zoom"));
  if (p.get("fov")) $("fov").value = p.get("fov");
  if (p.get("start")) $("start").value = p.get("start");
  if (p.get("end")) $("end").value = p.get("end");
  if (p.get("ra") != null && p.get("dec") != null) {
    $("coords").value = `${p.get("ra")} ${p.get("dec")}`;
    echoCoords();
    return true;
  }
  return false;
}

// ----------------------------------------------------------------- init ---

async function init() {
  try {
    const r = await fetch("api/config");
    if (r.ok) cfg = { ...cfg, ...(await r.json()) };
  } catch { /* fall back to the built-in limits */ }
  for (const id of ["start", "end"]) { $(id).min = cfg.date.min; $(id).max = cfg.date.max; }
  $("start").value = cfg.date.min;
  $("end").value = cfg.date.max;
  $("date-min").textContent = cfg.date.min;
  $("fov").min = cfg.fov.min; $("fov").max = cfg.fov.max; $("fov").value = cfg.fov.default;
  $("fov-min").textContent = cfg.fov.min; $("fov-max").textContent = cfg.fov.max;
  buildBandChips();

  $("query").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = validateForm();
    if (q.error) return showError(q.error);
    load(q);
  });
  $("coords").addEventListener("input", () => { echoCoords(); $("coords").classList.remove("invalid"); });
  $("preset").addEventListener("change", () => {
    if (!$("preset").value) return;
    $("coords").value = $("preset").value;
    echoCoords();
    $("query").requestSubmit();
  });
  $("play").onclick = () => setPlaying(!state.playing);
  $("prev").onclick = () => { setPlaying(false); step(-1); };
  $("next").onclick = () => { setPlaying(false); step(1); };
  $("frame").oninput = () => { setPlaying(false); state.frame = Number($("frame").value); draw(); };
  $("speed").oninput = () => { $("speed-val").textContent = `${$("speed").value} fps`; };
  $("group").onchange = () => { state.group = $("group").value; rebuild(); syncUrl(); };
  $("mode").onchange = () => { state.mode = $("mode").value; state.limits = null; draw(); };
  for (const id of ["stretch", "invert", "smooth", "cross"]) $(id).onchange = draw;
  $("white").oninput = draw;
  $("wapply").onclick = () => {
    let lo = Number($("wmin").value), hi = Number($("wmax").value);
    if (!(lo >= 0.75 && hi <= 5 && lo < hi)) return showError("Custom wavelengths must satisfy 0.75 ≤ min < max ≤ 5.0 µm.");
    showError("");
    setBand(`c:${lo}-${hi}`);
  };
  $("view").addEventListener("mousemove", onHover);
  $("view").addEventListener("click", (ev) => {
    if (!state.frames.length) return;
    const r = $("view").getBoundingClientRect(), { m, x0 } = crop();
    Measure.pickAt(x0 + ((ev.clientX - r.left) / r.width) * m - 0.5, x0 + (1 - (ev.clientY - r.top) / r.height) * m - 0.5);
  });
  $("view").addEventListener("mouseleave", () => { $("readout").textContent = ""; });
  window.addEventListener("resize", () => { draw(); drawTimeline(); });
  document.addEventListener("keydown", (ev) => {
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(ev.target.tagName)) return;
    if (ev.key === " ") { ev.preventDefault(); setPlaying(!state.playing); }
    if (ev.key === "ArrowRight") { setPlaying(false); step(1); }
    if (ev.key === "ArrowLeft") { setPlaying(false); step(-1); }
  });

  tick();
  if (readUrl()) {
    const q = validateForm();
    if (q.error) showError(q.error);
    else load(q);
  }
}

init();

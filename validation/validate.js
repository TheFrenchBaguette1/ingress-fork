/* Checks the Measure feature against independent data.
 *
 *   1. Fluxes of ordinary stars against the 2MASS and AllWISE catalogues.
 *   2. The pulsation period of R Draconis against its catalogued period.
 *
 * Drives the real page in a headless browser, so it tests the code users
 * run. Start the server first, then:
 *
 *   node validation/validate.js [http://localhost:8000]
 *
 * Needs Playwright (npm i playwright). Catalogue files in this folder come
 * from IRSA's TAP service (tables fp_psc and allwise_p3as_psd, 4.5' cone).
 */
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://localhost:8000";
const FIELD = { ra: 133.795129, dec: -7.245147, fov: 10 };
// Filter: [catalogue column, zero-magnitude flux in Jy, wavelength window in µm]
const FILTERS = {
  J: ["j_m", 1594, [1.17, 1.33]], H: ["h_m", 1024, [1.51, 1.79]], Ks: ["k_m", 666.7, [2.03, 2.30]],
  W1: ["w1mpro", 309.54, [3.0, 3.8]], W2: ["w2mpro", 171.787, [4.1, 5.0]],
};
const R_DRA = { ra: 248.1675, dec: 66.755, period: 245.6 }; // period in days, GCVS

const csv = (f) => {
  const [head, ...rows] = fs.readFileSync(path.join(__dirname, f), "utf8").trim().split("\n");
  const keys = head.split(",");
  return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [keys[i], v])));
};
const sep = (a, b) => Math.hypot((a.ra - b.ra) * Math.cos((a.dec * Math.PI) / 180), a.dec - b.dec) * 3600;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

async function openField(page, f, extra = "") {
  await page.goto(`${BASE}/?ra=${f.ra}&dec=${f.dec}&fov=${f.fov || 10}&group=pass${extra}`);
  await page.waitForFunction(() => !state.loading && state.field && state.exposures.length > 0, null, { timeout: 600000 });
}
const measure = (page, s) => page.evaluate(([ra, dec]) => {
  Measure.pickSky(ra, dec);
  const r = Measure.result();
  return r && { halo: r.geometry.halo, points: r.points.map((p) => ({ mjd: p.mjd, wave: p.wave, flux: p.flux, err: p.err, sat: p.saturated, rel: p.rel, relErr: p.relErr })) };
}, [s.ra, s.dec]);

async function fluxCheck(page) {
  const tm = csv("twomass_wise0855_field.csv").map((r) => ({ ...r, ra: +r.ra, dec: +r.dec }));
  const wise = csv("allwise_wise0855_field.csv").map((r) => ({ ...r, ra: +r.ra, dec: +r.dec }));
  // Well-measured, isolated stars away from the edge of the field.
  const stars = tm.filter((s) => /^[AB]/.test(s.ph_qual) && s.cc_flg === "000" && +s.j_m < 15.5 &&
    Math.abs(s.dec - FIELD.dec) * 3600 < 230 && Math.abs((s.ra - FIELD.ra) * Math.cos((FIELD.dec * Math.PI) / 180)) * 3600 < 230 &&
    !tm.some((o) => o !== s && sep(o, s) < 35 && +o.j_m < +s.j_m + 2.5));
  await openField(page, FIELD);
  const ratios = Object.fromEntries(Object.keys(FILTERS).map((k) => [k, []]));
  const rows = [];
  for (const s of stars) {
    const m = await measure(page, s);
    if (!m || m.halo) continue;
    const w = wise.filter((o) => sep(o, s) < 3 && o.ext_flg === "0" && o.cc_flags === "0000")[0];
    const row = { ra: s.ra.toFixed(5), dec: s.dec.toFixed(5), j_mag: +s.j_m };
    for (const [name, [col, zero, [lo, hi]]] of Object.entries(FILTERS)) {
      const src = name.startsWith("W") ? w : s;
      const pts = m.points.filter((p) => !p.sat && p.wave >= lo && p.wave <= hi);
      if (!src || !(+src[col] > 0) || pts.length < 4) continue;
      const quality = src.ph_qual["JHK".indexOf(name[0]) >= 0 ? "JHK".indexOf(name[0]) : +name[1] - 1];
      if (!/[AB]/.test(quality)) continue; // only well-measured catalogue values
      const ours = pts.reduce((t, p) => t + p.flux, 0) / pts.length;
      const ratio = ours / (zero * 1e3 * 10 ** (-0.4 * +src[col]));
      ratios[name].push(ratio);
      row[name] = ratio.toFixed(3);
    }
    rows.push(row);
  }
  console.log(`\n1. Flux against 2MASS and AllWISE (${rows.length} isolated stars, J = ${Math.min(...rows.map((r) => r.j_mag)).toFixed(1)} to ${Math.max(...rows.map((r) => r.j_mag)).toFixed(1)} mag)`);
  console.log("   ratio = Ingress aperture flux / catalogue flux");
  const summary = {};
  for (const [name, r] of Object.entries(ratios)) {
    if (r.length < 3) { console.log(`   ${name.padEnd(3)} too few stars (${r.length})`); continue; }
    const med = median(r), scatter = 1.4826 * median(r.map((v) => Math.abs(v - med)));
    summary[name] = { stars: r.length, median: +med.toFixed(3), scatter: +scatter.toFixed(3) };
    console.log(`   ${name.padEnd(3)} median ${med.toFixed(3)}  scatter ${scatter.toFixed(3)}  (${r.length} stars)`);
  }
  return { stars: rows, summary };
}

/** Least-squares sinusoid of fixed period; returns chi-square and amplitude. */
function sineFit(t, y, w, P) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  t.forEach((ti, k) => {
    const f = [1, Math.sin((2 * Math.PI * ti) / P), Math.cos((2 * Math.PI * ti) / P)];
    for (let i = 0; i < 3; i++) { b[i] += w[k] * f[i] * y[k]; for (let j = 0; j < 3; j++) A[i][j] += w[k] * f[i] * f[j]; }
  });
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) { const m = A[j][i] / A[i][i]; for (let k = 0; k < 3; k++) A[j][k] -= m * A[i][k]; b[j] -= m * b[i]; }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) x[i] = (b[i] - A[i].slice(i + 1).reduce((s, a, k) => s + a * x[i + 1 + k], 0)) / A[i][i];
  let chi = 0;
  t.forEach((ti, k) => { const m = x[0] + x[1] * Math.sin((2 * Math.PI * ti) / P) + x[2] * Math.cos((2 * Math.PI * ti) / P); chi += w[k] * (y[k] - m) ** 2; });
  return { chi, amplitude: Math.hypot(x[1], x[2]) };
}

async function periodCheck(page) {
  await openField(page, R_DRA);
  const m = await measure(page, R_DRA);
  // Nightly means of relative brightness, as magnitudes.
  const nights = new Map();
  for (const p of m.points) {
    if (!(p.rel > 0) || !(p.relErr > 0)) continue;
    const k = Math.floor(p.mjd), n = nights.get(k) || { sw: 0, swx: 0, n: 0 };
    const w = 1 / p.relErr ** 2; n.sw += w; n.swx += w * p.rel; n.n++; nights.set(k, n);
  }
  const t = [], y = [], w = [];
  for (const [k, n] of nights) {
    if (n.n < 2) continue;
    const rel = n.swx / n.sw, err = Math.hypot(1 / Math.sqrt(n.sw), 0.03) / rel * 1.0857; // 3% floor
    t.push(k); y.push(-2.5 * Math.log10(rel)); w.push(1 / err ** 2);
  }
  let best = null;
  const scan = [];
  for (let P = 120; P <= 500; P += 1) { const f = sineFit(t, y, w, P); scan.push([P, f.chi]); if (!best || f.chi < best.chi) best = { P, ...f }; }
  // Rescale so the best fit has chi-square per degree of freedom of one, then take delta chi-square = 1.
  const scale = best.chi / (t.length - 4);
  const ok = scan.filter(([, chi]) => (chi - best.chi) / scale <= 1).map(([P]) => P);
  const flat = sineFit(t, y, w, 1e9).chi;
  console.log(`\n2. R Draconis pulsation (${t.length} nights over ${Math.max(...t) - Math.min(...t)} days, halo photometry)`);
  console.log(`   best-fit period ${best.P} days (1-sigma range ${Math.min(...ok)} to ${Math.max(...ok)}); catalogued ${R_DRA.period} days`);
  console.log(`   amplitude ${(2 * best.amplitude).toFixed(2)} mag peak to peak; sinusoid removes ${(100 * (1 - best.chi / flat)).toFixed(0)}% of the variance of a constant`);
  return { nights: t.length, span_days: Math.max(...t) - Math.min(...t), best_period: best.P, range: [Math.min(...ok), Math.max(...ok)], catalogued: R_DRA.period, peak_to_peak_mag: +(2 * best.amplitude).toFixed(2), variance_removed: +(1 - best.chi / flat).toFixed(2) };
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const out = { date: new Date().toISOString().slice(0, 10), flux: await fluxCheck(page), period: await periodCheck(page) };
  fs.writeFileSync(path.join(__dirname, "results.json"), JSON.stringify(out, null, 1));
  await browser.close();
})();

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
const R_DRA = { ra: 248.1675, dec: 66.755 }; // its catalogued period is held in frontend/period.js

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

async function periodCheck(page) {
  // The page's own period search (frontend/period.js), on the page's own
  // measurements of the star.
  await openField(page, R_DRA);
  const a = await page.evaluate(([ra, dec]) => {
    Measure.pickSky(ra, dec);
    const r = Period.result(), ref = Period.referenceFor(Measure.picked());
    return { status: r.status, nights: r.nights, span: r.span, period: r.period, lo: r.lo, hi: r.hi, amplitude: r.amplitude, explained: r.explained, ref: ref && ref.period, cmp: ref && r.status === "ok" ? Period.compare(r, ref) : null };
  }, [R_DRA.ra, R_DRA.dec]);
  console.log(`\n2. R Draconis pulsation (${a.nights} nights over ${a.span} days, halo photometry)`);
  if (a.status !== "ok") { console.log(`   no period reported (${a.status})`); return a; }
  console.log(`   best-fit period ${a.period} days (1-sigma range ${a.lo} to ${a.hi}); catalogued ${a.ref} days: ${a.cmp.level} (${a.cmp.nSigma.toFixed(2)} sigma)`);
  console.log(`   amplitude ${a.amplitude.toFixed(2)} mag peak to peak; sinusoid explains ${(100 * a.explained).toFixed(0)}% of the variance about a constant`);
  return { nights: a.nights, span_days: a.span, best_period: a.period, range: [a.lo, a.hi], catalogued: a.ref, consistency: a.cmp.level, n_sigma: +a.cmp.nSigma.toFixed(2), peak_to_peak_mag: +a.amplitude.toFixed(2), variance_removed: +a.explained.toFixed(2) };
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const out = { date: new Date().toISOString().slice(0, 10), flux: await fluxCheck(page), period: await periodCheck(page) };
  fs.writeFileSync(path.join(__dirname, "results.json"), JSON.stringify(out, null, 1));
  await browser.close();
})();

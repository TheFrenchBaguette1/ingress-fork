"use strict";
/* AI reading of a measured object.
 *
 * Once an object has been clicked and every exposure has loaded, the numbers
 * the page has already computed (spectrum, change between survey passes, and
 * how fair the comparison over time is) are sent to the server, which asks an
 * OpenAI model to say what each means and whether it is significant. The
 * key lives on the server; this file never sees it.
 *
 * Uses the globals of app.js (state, cfg, $, fmtDate, fmtSexa) and Measure.
 */

const Insight = (() => {
  const LEVELS = {
    "significant": ["Significant", "sig"],
    "possibly significant": ["Possibly significant", "maybe"],
    "not significant": ["Not significant", "no"],
    "cannot tell": ["Cannot tell", "unknown"],
    "context": ["Context", "context"],
  };
  let enabled = null; // unknown until the server says whether a key is set
  let shownFor = null; // which measurement the panel currently describes
  let timer = 0, inFlight = null;
  const cache = new Map();

  const num = (v, digits = 4) => (Number.isFinite(v) ? +v.toPrecision(digits) : null);
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };

  /** Everything the page knows about the selected object, as plain data. */
  function snapshot(res, obj) {
    const f = state.field;
    const change = (c) => (c ? { change_pct: num((c.value - 1) * 100, 3), err_pct: num(c.err * 100, 2), exposures: c.n } : null);

    // The spectrum, binned to six slices per detector band for each pass.
    const bins = new Map();
    for (const p of res.points) {
      const [lo, hi] = cfg.bands[`D${p.det}`] || [0, 1];
      const slice = Math.min(5, Math.max(0, Math.floor(((p.wave - lo) / (hi - lo)) * 6)));
      const id = `${p.pass}|${p.det}|${slice}`;
      if (!bins.has(id)) bins.set(id, { pass: p.pass, det: p.det, pts: [] });
      bins.get(id).pts.push(p);
    }
    const spectrum = res.passes.map((ps) => ({
      pass: ps.index + 1,
      points: [...bins.values()].filter((b) => b.pass === ps.index).map((b) => {
        const ok = b.pts.filter((p) => !p.saturated);
        const use = ok.length ? ok : b.pts;
        return [num(median(use.map((p) => p.wave))), b.det, num(median(use.map((p) => p.flux))), num(median(use.map((p) => p.err)), 2), use.length, ok.length ? 0 : 1];
      }).sort((a, b) => a[0] - b[0]),
    }));

    const v = res.verdict;
    const data = {
      object: { ra_deg: num(obj.ra, 8), dec_deg: num(obj.dec, 7), position: fmtSexa(obj.ra, obj.dec) },
      field: {
        centre_ra_deg: num(f.ra, 8), centre_dec_deg: num(f.dec, 7), field_of_view_arcmin: f.fov_arcmin,
        dates: f.mjd_start ? `${fmtDate(f.mjd_start)} to ${fmtDate(f.mjd_end - 1)}` : null,
        exposures_loaded: state.exposures.length, still_loading: !!state.loading,
      },
      photometry: {
        method: res.geometry.halo
          ? `halo ring from ${res.geometry.in.toFixed(0)} to ${res.geometry.out.toFixed(0)} arcsec (star too bright to measure at its centre)`
          : "aperture, 9.5 arcsec radius",
        measurements: res.points.length, saturated_measurements: res.saturated,
        spectrum_columns: ["wavelength_um", "band", "flux_mJy", "err_mJy", "exposures", "saturated"],
        spectrum,
        passes: res.passes.map((ps) => ({
          pass: ps.index + 1, from: fmtDate(ps.t0), to: fmtDate(ps.t1), measurements: ps.n,
          all_bands: change(ps.all),
          by_band: Object.fromEntries(ps.bands.map((b, k) => [`band_${k + 1}`, change(b)])),
        })),
        verdict: v ? {
          label: v.sigma >= 5 ? "variable" : v.sigma >= 3 ? "possibly variable" : "no significant change",
          between: `pass ${v.a.index + 1} (${fmtDate(v.a.t0).slice(0, 7)}) and pass ${v.b.index + 1} (${fmtDate(v.b.t0).slice(0, 7)})`,
          change_pct: num(v.diff * 100, 3), err_pct: num(v.err * 100, 2), sigma: num(v.sigma, 3),
        } : null,
      },
      comparison: {
        view: state.view === "explore" ? "explore wavelengths" : "compare over time",
        wavelength_selection: state.band, showing: state.mode === "diff" ? "difference from the average" : "images",
      },
      page_summary: ($("measure-summary").innerText || "").slice(0, 600),
    };
    const r = state.frames && state.frames.report;
    if (state.view !== "explore" && r) {
      data.comparison.report = {
        status: r.status, why: r.why || null, slices_matched: r.slices, slices_seen: r.slicesTotal, noisy_exposures_left_out: r.noisy,
        field_seen_in_every_epoch: num(r.sharedPixels, 3), mean_wavelength_spread: num(r.waveSpread, 3),
        stars_used_for_alignment: r.stars ?? null, largest_offset_arcsec: num(r.maxShift, 3), star_width_spread: num(r.widthSpread, 3),
        epochs: r.epochs.map((e) => ({
          epoch: e.index + 1, from: fmtDate(e.t0), to: fmtDate(e.t1), used: !!e.used, left_out_because: e.used ? null : e.reason || null,
          exposures_used: e.nUsed ?? null, exposures_available: e.exposures.length, mean_wavelength_um: num(e.wave),
          offset_arcsec: num(e.shift, 3), star_width_vs_average: num(e.width, 4),
        })),
      };
    }
    const panel = $("context");
    if (panel && !panel.hidden) data.comparison.panel_text = (panel.innerText || "").replace(/\s+/g, " ").slice(0, 1800);
    return data;
  }

  const keyOf = (obj) => {
    const f = state.field;
    return [obj.ra.toFixed(5), obj.dec.toFixed(5), f.ra, f.dec, f.fov_arcmin, f.mjd_start, f.mjd_end, state.exposures.length].join("|");
  };

  // -------------------------------------------------------------- panel ---

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text; // model output is only ever inserted as text
    return node;
  };
  const badge = (level) => {
    const [label, cls] = LEVELS[level] || LEVELS["cannot tell"];
    return el("span", `lvl lvl-${cls}`, label);
  };

  function status(text, busy) {
    $("insight-status").textContent = text || "";
    $("insight-status").hidden = !text;
    $("insight").classList.toggle("busy", !!busy);
  }

  function show(answer) {
    const body = $("insight-body"), r = answer.reading;
    body.textContent = "";
    const head = el("div", "insight-headline");
    head.append(badge(r.overall), el("p", null, r.headline));
    body.append(head);
    const list = el("div", "findings");
    for (const f of r.findings || []) {
      const item = el("article", "finding");
      const top = el("div", "finding-top");
      top.append(el("h4", null, f.title), badge(f.significance));
      item.append(top, el("p", null, f.what_it_shows), el("p", "why", f.why));
      list.append(item);
    }
    body.append(list);
    for (const [title, items] of [["What could mislead here", r.cautions], ["Ways to check", r.next_steps]]) {
      if (!items || !items.length) continue;
      const block = el("div", "insight-list");
      block.append(el("h4", null, title));
      const ul = el("ul");
      for (const t of items) ul.append(el("li", null, t));
      block.append(ul);
      body.append(block);
    }
    $("insight-model").textContent = answer.model ? `Model: ${answer.model}` : "";
    $("insight-again").hidden = false;
    status("");
  }

  async function run(key, data) {
    if (inFlight) inFlight.abort();
    const ctl = (inFlight = new AbortController());
    status("Reading the measurements…", true);
    try {
      const resp = await fetch("api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal: ctl.signal });
      const answer = await resp.json().catch(() => null);
      if (!resp.ok || !answer || !answer.reading) {
        const detail = answer && answer.detail;
        if (detail && detail.code === "not_configured") enabled = false;
        throw new Error((detail && detail.message) || "The AI reading failed. Try again.");
      }
      cache.set(key, answer);
      if (shownFor === key) show(answer);
    } catch (e) {
      if (e.name === "AbortError") return;
      if (shownFor !== key) return;
      $("insight-body").textContent = "";
      $("insight-again").hidden = enabled === false;
      status(e.message);
    } finally {
      if (inFlight === ctl) inFlight = null;
    }
  }

  function cancel() {
    clearTimeout(timer);
    if (inFlight) { inFlight.abort(); inFlight = null; }
  }

  /** Called whenever the measurements change. */
  function update(force) {
    const box = $("insight");
    if (!box) return;
    const res = Measure.result(), obj = Measure.picked();
    if (!res || !res.points.length || !obj || !state.field) { box.hidden = true; cancel(); shownFor = null; return; }
    box.hidden = false;
    if (enabled === false) {
      cancel(); shownFor = null;
      $("insight-body").textContent = ""; $("insight-again").hidden = true; $("insight-model").textContent = "";
      status("The AI reading is off. To switch it on, set OPENAI_API_KEY on the server (see .env.example) and restart it.");
      return;
    }
    if (enabled === null) return; // still asking the server; init() calls back
    if (state.loading) {
      cancel(); shownFor = null;
      $("insight-body").textContent = ""; $("insight-again").hidden = true;
      status("The AI reading starts once every exposure has loaded.");
      return;
    }
    const key = keyOf(obj);
    if (key === shownFor && !force) return; // already shown, or on its way
    cancel();
    shownFor = key;
    if (force) cache.delete(key);
    if (cache.has(key)) { show(cache.get(key)); return; }
    $("insight-body").textContent = ""; $("insight-again").hidden = true;
    status("Reading the measurements…", true);
    // Wait a moment so a quick run of clicks asks only once, for the last object.
    timer = setTimeout(() => run(key, snapshot(Measure.result(), Measure.picked())), force ? 0 : 700);
  }

  async function init() {
    $("insight-again").onclick = () => update(true);
    try {
      const resp = await fetch("api/analyze");
      enabled = resp.ok ? !!(await resp.json()).enabled : false;
    } catch { enabled = false; }
    update();
  }

  return { init, update };
})();
window.Insight = Insight;

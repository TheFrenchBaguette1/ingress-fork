"use strict";
/* Decorative scroll story above the viewer: the planet crossing the star in
 * the hero, and three scenes drawn on one canvas as the page scrolls (the
 * sky being scanned, the 102 spectral channels, a patch blinking between
 * survey passes). Nothing here reads or changes the viewer's state.
 */
(() => {
  const root = document.documentElement;
  const story = document.getElementById("story");
  const cv = document.getElementById("story-canvas");
  const sky = document.getElementById("sky");
  if (!story || !cv || !cv.getContext) return;
  const ctx = cv.getContext("2d");
  const reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  const chapters = [...story.querySelectorAll(".chapter")];
  const stat = {};
  for (const el of story.querySelectorAll("[data-stat]")) stat[el.dataset.stat] = el;

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const INK = "241,239,233", AMBER = "#f2b441", TEAL = "#5fd3c4";
  const BAND_COLORS = ["#6aa9ff", "#5fd3c4", "#9bd45a", "#f2c94c", "#f2994a", "#eb5757"];
  const BANDS = [[0.75, 1.11], [1.1, 1.63], [1.63, 2.42], [2.42, 3.82], [3.81, 4.42], [4.41, 5.0]];
  const MONO = '"Geist Mono", ui-monospace, Menlo, monospace';

  function seeded(seed) {
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  // A link that names a field goes straight to the viewer.
  if (new URLSearchParams(location.search).has("ra")) {
    const viewer = document.getElementById("viewer");
    if (viewer) viewer.scrollIntoView();
  }

  // Headings rise into place the first time they come into view.
  const waiting = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window) {
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); seen.unobserve(e.target); }
    }, { rootMargin: "0px 0px -12% 0px" });
    waiting.forEach((el) => seen.observe(el));
  } else waiting.forEach((el) => el.classList.add("in"));

  // ------------------------------------------------------------ scene 1 ---
  // The celestial sphere, filling with scan circles through the ecliptic poles.

  const sphereStars = (() => {
    const rand = seeded(1802), out = [];
    const g = [0.48, 0.62, 0.62]; // normal of the band of the Milky Way
    while (out.length < 1500) {
      const z = 2 * rand() - 1, a = 2 * Math.PI * rand(), r = Math.sqrt(1 - z * z);
      const v = [r * Math.cos(a), z, r * Math.sin(a)];
      const d = (v[0] * g[0] + v[1] * g[1] + v[2] * g[2]) / 0.24;
      if (rand() > 0.22 + 0.78 * Math.exp(-d * d)) continue;
      const m = rand();
      out.push({ v, s: 0.5 + 1.3 * m * m * m, a: 0.25 + 0.75 * rand() });
    }
    return out;
  })();

  function drawSphere(cx, cy, R, t, time) {
    const yaw = 0.7 + time * 0.035 + t * 0.9, tilt = 0.36, roll = -0.3;
    const cy_ = Math.cos(yaw), sy_ = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt), cr = Math.cos(roll), sr = Math.sin(roll);
    const project = (x, y, z) => {
      const x1 = x * cy_ + z * sy_, z1 = -x * sy_ + z * cy_;
      const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
      return [cx + R * (x1 * cr - y2 * sr), cy - R * (x1 * sr + y2 * cr), z2];
    };
    const onSphere = (lon, lat) => project(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));

    // A curve on the sphere, drawn in two strengths: near side and far side.
    const curve = (pt, steps, front, back, width) => {
      const near = new Path2D(), far = new Path2D();
      let prev = pt(0);
      for (let k = 1; k <= steps; k++) {
        const p = pt(k / steps), path = (p[2] + prev[2]) / 2 >= 0 ? near : far;
        path.moveTo(prev[0], prev[1]);
        path.lineTo(p[0], p[1]);
        prev = p;
      }
      ctx.lineWidth = width;
      ctx.strokeStyle = back; ctx.stroke(far);
      ctx.strokeStyle = front; ctx.stroke(near);
    };
    const TAU = 2 * Math.PI;

    // Stars behind, then the graticule, then stars in front.
    const dot = (s, k) => {
      const p = project(s.v[0], s.v[1], s.v[2]);
      if ((p[2] >= 0) !== k) return;
      ctx.globalAlpha = (k ? 1 : 0.28) * s.a;
      ctx.fillRect(p[0] - s.s / 2, p[1] - s.s / 2, s.s, s.s);
    };
    const base = ctx.globalAlpha;
    ctx.fillStyle = "#fff";
    for (const s of sphereStars) dot(s, false);
    ctx.globalAlpha = base;
    for (let k = 0; k < 6; k++) curve((u) => onSphere((k * Math.PI) / 6, u * TAU), 72, `rgba(${INK},0.13)`, `rgba(${INK},0.05)`, 1);
    for (const lat of [-60, -30, 0, 30, 60]) {
      const l = (lat * Math.PI) / 180;
      curve((u) => onSphere(u * TAU, l), 72, `rgba(${INK},${lat ? 0.13 : 0.2})`, `rgba(${INK},0.05)`, 1);
    }

    // Coverage: one great circle per scan, each through both poles.
    const SCANS = 64, done = Math.floor(t * SCANS);
    for (let k = 0; k < done; k++) curve((u) => onSphere((k / SCANS) * Math.PI, u * TAU), 60, `rgba(${INK},0.42)`, `rgba(${INK},0.1)`, 1);
    ctx.save();
    ctx.shadowColor = AMBER; ctx.shadowBlur = 14;
    curve((u) => onSphere(t * Math.PI, u * TAU), 90, AMBER, "rgba(242,180,65,0.35)", 1.6);
    ctx.restore();

    ctx.fillStyle = "#fff";
    for (const s of sphereStars) dot(s, true);
    ctx.globalAlpha = base;

    ctx.strokeStyle = `rgba(${INK},0.28)`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();

    // The ecliptic poles, where every scan crosses.
    ctx.font = `11px ${MONO}`; ctx.textBaseline = "middle";
    for (const [lat, name] of [[1, "North ecliptic pole"], [-1, "South ecliptic pole"]]) {
      const p = onSphere(0, (lat * Math.PI) / 2);
      ctx.globalAlpha = base * (p[2] >= 0 ? 1 : 0.4);
      ctx.strokeStyle = AMBER; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, TAU); ctx.stroke();
      ctx.fillStyle = `rgba(${INK},0.7)`;
      ctx.textAlign = "left";
      ctx.fillText(name, p[0] + 12, p[1]);
    }
    ctx.globalAlpha = base;
    if (stat.cover) stat.cover.textContent = `${Math.round(t * 100)}%`;
  }

  // ------------------------------------------------------------ scene 2 ---
  // 102 spectral channels, six detectors of 17, lighting up from blue to red.

  const channels = (() => {
    const shape = (w) => Math.pow(w, 3) * Math.exp(-w / 0.55) * (1 - 0.45 * Math.exp(-(((w - 3.05) / 0.2) ** 2))) * (1 - 0.35 * Math.exp(-(((w - 4.27) / 0.09) ** 2)));
    const out = [];
    BANDS.forEach(([lo, hi], b) => {
      for (let j = 0; j < 17; j++) {
        const wave = lo * Math.pow(hi / lo, (j + 0.5) / 17);
        out.push({ b, wave, f: shape(wave), u: (b * 18.6 + j + 0.5) / (6 * 18.6 - 1.6) });
      }
    });
    const top = Math.max(...out.map((c) => c.f));
    for (const c of out) c.f = 0.1 + 0.9 * (c.f / top);
    return out;
  })();

  function drawSpectrum(cx, cy, size, t) {
    const W = size * 2.25, H = size * 1.15, x0 = cx - W / 2, y0 = cy + size * 0.6;
    const lit = clamp(Math.ceil(t * 102), 1, 102);
    ctx.lineCap = "butt";
    const base = ctx.globalAlpha;
    channels.forEach((c, i) => {
      const x = Math.round(x0 + c.u * W) + 0.5, on = i < lit;
      ctx.globalAlpha = base * (on ? 1 : 0.22);
      ctx.strokeStyle = on ? BAND_COLORS[c.b] : `rgb(${INK})`;
      ctx.lineWidth = on ? 1.6 : 1;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 - (on ? c.f * H : 7)); ctx.stroke();
    });
    ctx.globalAlpha = base;

    // The channel being read, picked out with a guide.
    const head = channels[lit - 1], hx = Math.round(x0 + head.u * W) + 0.5;
    ctx.strokeStyle = `rgba(${INK},0.3)`; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(hx, y0 - head.f * H - 10); ctx.lineTo(hx, y0 - H - 26); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = `rgb(${INK})`;
    ctx.beginPath(); ctx.arc(hx, y0 - head.f * H, 3, 0, 2 * Math.PI); ctx.fill();
    ctx.font = `11px ${MONO}`; ctx.textBaseline = "alphabetic";
    ctx.textAlign = head.u > 0.85 ? "right" : "left";
    ctx.fillText(`${head.wave.toFixed(2)} µm`, hx + (head.u > 0.85 ? -8 : 8), y0 - H - 20);

    // Detector bands beneath.
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    BANDS.forEach((_, b) => {
      const a = x0 + channels[b * 17].u * W - 3, z = x0 + channels[b * 17 + 16].u * W + 3;
      ctx.strokeStyle = BAND_COLORS[b]; ctx.globalAlpha = base * 0.8; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a, y0 + 10.5); ctx.lineTo(z, y0 + 10.5); ctx.stroke();
      ctx.globalAlpha = base;
      ctx.fillStyle = `rgba(${INK},0.6)`;
      ctx.fillText(`Band ${b + 1}`, (a + z) / 2, y0 + 19);
    });
    if (stat.wave) stat.wave.textContent = `${head.wave.toFixed(2)} µm`;
    if (stat.chan) stat.chan.textContent = lit;
  }

  // ------------------------------------------------------------ scene 3 ---
  // One patch over four survey passes: one object moves, one varies.

  const PASSES = ["2025-05", "2025-11", "2026-05", "2026-11"];
  const VARIES = [1, 0.42, 0.85, 0.3];
  const field = (() => {
    const rand = seeded(855), out = [];
    for (let k = 0; k < 120; k++) out.push({ x: 0.03 + 0.94 * rand(), y: 0.03 + 0.94 * rand(), m: Math.pow(rand(), 2.4), j: [0, 1, 2, 3].map(() => 0.88 + 0.24 * rand()) });
    return out;
  })();
  const glow = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d"), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
    grad.addColorStop(0.6, "rgba(255,255,255,0.1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    return c;
  })();

  function drawBlink(cx, cy, size, t) {
    const S = size * 2, x0 = Math.round(cx - S / 2), y0 = Math.round(cy - S / 2), u = S / 520;
    const e = clamp(Math.floor(t * 4), 0, 3), base = ctx.globalAlpha;
    ctx.fillStyle = "#000"; ctx.fillRect(x0, y0, S, S);

    const star = (x, y, m, a) => {
      const d = (5 + 30 * m) * u;
      ctx.globalAlpha = base * clamp(a);
      ctx.drawImage(glow, x0 + x * S - d / 2, y0 + y * S - d / 2, d, d);
    };
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, S, S); ctx.clip();
    for (const s of field) star(s.x, s.y, s.m, (0.3 + 0.7 * s.m) * s.j[e]);
    star(0.73, 0.29, 0.75 * VARIES[e] + 0.1, 0.25 + 0.75 * VARIES[e]); // the variable
    const at = (k) => [0.35 + 0.07 * k, 0.63 - 0.05 * k]; // the mover
    const [mx, my] = at(e);
    star(mx, my, 0.5, 0.95);
    ctx.restore();
    ctx.globalAlpha = base;

    // Where the mover has been, and the ring that follows it.
    ctx.lineWidth = 1; ctx.strokeStyle = TEAL;
    ctx.setLineDash([3, 4]); ctx.globalAlpha = base * 0.55;
    ctx.beginPath(); ctx.moveTo(x0 + at(0)[0] * S, y0 + at(0)[1] * S); ctx.lineTo(x0 + mx * S, y0 + my * S); ctx.stroke();
    ctx.setLineDash([]);
    for (let k = 0; k < e; k++) { ctx.beginPath(); ctx.arc(x0 + at(k)[0] * S, y0 + at(k)[1] * S, 3 * u + 1, 0, 2 * Math.PI); ctx.stroke(); }
    ctx.globalAlpha = base; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.arc(x0 + mx * S, y0 + my * S, 15 * u + 3, 0, 2 * Math.PI); ctx.stroke();

    // Frame, rulers and the viewer's own crosshair.
    ctx.strokeStyle = `rgba(${INK},0.35)`; ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, S - 1, S - 1);
    ctx.beginPath();
    for (let k = 0; k <= 50; k++) {
      const len = k % 5 ? 4 : 9, p = (k / 50) * S;
      ctx.moveTo(x0 + p + 0.5, y0 - 6); ctx.lineTo(x0 + p + 0.5, y0 - 6 - len);
      ctx.moveTo(x0 - 6, y0 + p + 0.5); ctx.lineTo(x0 - 6 - len, y0 + p + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = AMBER; ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(cx + dx * 9 * u, cy + dy * 9 * u); ctx.lineTo(cx + dx * 24 * u, cy + dy * 24 * u);
    }
    ctx.stroke();

    ctx.font = `11px ${MONO}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    const label = `${e + 1}/4  ${PASSES[e]}`, lw = ctx.measureText(label).width + 16;
    ctx.fillStyle = "rgba(5,6,10,0.78)"; ctx.fillRect(x0 + 9, y0 + 9, lw, 22);
    ctx.fillStyle = `rgb(${INK})`; ctx.fillText(label, x0 + 17, y0 + 20.5);
    if (stat.pass) stat.pass.textContent = `Pass ${e + 1}`;
    if (stat.date) stat.date.textContent = PASSES[e];
  }

  // ------------------------------------------------------------- driver ---

  let w = 0, h = 0, raf = 0, last = -1;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = cv.clientWidth; h = cv.clientHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function render(time) {
    raf = 0;
    const vh = window.innerHeight, y = window.scrollY;
    root.style.setProperty("--ing", clamp(y / vh).toFixed(4));
    if (sky) sky.style.transform = `translate3d(0,${(-Math.min(y, 6 * vh) * 0.012).toFixed(1)}px,0)`;

    const box = story.getBoundingClientRect();
    if (box.top > vh || box.bottom < 0 || !w) return;
    const p = clamp(-box.top / Math.max(1, box.height - vh)), s = p * 3;
    story.style.setProperty("--p", p.toFixed(4));
    const active = clamp(Math.floor(s), 0, 2);
    if (active !== last) { chapters.forEach((c, k) => c.classList.toggle("on", k === active)); last = active; }

    const wide = w >= 860;
    const cx = wide ? w * 0.67 : w / 2, cy = wide ? h * 0.5 : h * 0.33;
    const size = wide ? Math.min(w * 0.27, h * 0.36) : Math.min(w * 0.4, h * 0.24);
    ctx.clearRect(0, 0, w, h);
    const scenes = [drawSphere, drawSpectrum, drawBlink];
    scenes.forEach((draw, k) => {
      const local = s - k;
      const alpha = (k === 0 ? 1 : smooth(-0.1, 0.1, local)) * (k === 2 ? 1 : 1 - smooth(0.9, 1.1, local));
      if (alpha <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const rise = (1 - alpha) * 30 * (local < 0.5 ? 1 : -1);
      ctx.translate(0, rise);
      draw(cx, cy, k === 1 && !wide ? size * 0.72 : size, clamp((local - 0.1) / 0.72), time / 1000);
      ctx.restore();
    });
    // The sphere keeps turning while it is on screen.
    if (!reduce.matches && s < 1.1) schedule();
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(render); }

  resize();
  window.addEventListener("resize", () => { resize(); schedule(); });
  window.addEventListener("scroll", schedule, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  schedule();
})();

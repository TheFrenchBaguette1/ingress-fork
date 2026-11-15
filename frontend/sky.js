"use strict";
/* Decorative background only: a fixed field of stars with a faint celestial
 * grid behind the page. Nothing here reads or changes the viewer's state.
 */
(() => {
  const cv = document.getElementById("sky");
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext("2d");
  const still = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  const TINTS = ["#ffffff", "#ffffff", "#ffffff", "#cfe0ff", "#ffe2b0", "#ffc9d6"];
  let stars = [], w = 0, h = 0, dpr = 1;

  // The same sky on every visit: a small seeded generator.
  function seeded(seed) {
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const rand = seeded(20250311);
    const count = Math.min(900, Math.round((w * h) / 2400));
    stars = Array.from({ length: count }, (_, i) => {
      const m = rand();
      return {
        x: rand() * w, y: rand() * h,
        r: 0.35 + 1.3 * m * m * m,
        a: 0.3 + 0.6 * rand(),
        tint: TINTS[Math.floor(rand() * TINTS.length)],
        phase: rand() * 6.283, rate: 0.5 + rand() * 1.3,
        twinkle: i % 5 === 0,
      };
    });
    paint(0);
  }

  function paint(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Celestial grid: circles of declination and hour lines about a pole
    // that sits off the top right of the page.
    const px = w * 0.84, py = -h * 0.3, reach = Math.hypot(w, h) * 1.3;
    ctx.strokeStyle = "rgba(148,160,184,0.06)";
    ctx.lineWidth = 1;
    for (let r = 180; r < reach; r += 170) {
      ctx.beginPath();
      ctx.arc(px, py, r, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.beginPath();
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * 2 * Math.PI;
      ctx.moveTo(px + 180 * Math.cos(a), py + 180 * Math.sin(a));
      ctx.lineTo(px + reach * Math.cos(a), py + reach * Math.sin(a));
    }
    ctx.stroke();

    for (const s of stars) {
      const a = s.twinkle ? s.a * (0.6 + 0.4 * Math.sin(s.phase + t * s.rate)) : s.a;
      ctx.globalAlpha = a;
      ctx.fillStyle = s.tint;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, 2 * Math.PI);
      ctx.fill();
      if (s.r > 1.25) { // the brightest few get diffraction spikes
        ctx.globalAlpha = a * 0.35;
        ctx.strokeStyle = s.tint;
        ctx.lineWidth = 0.6;
        const L = s.r * 5;
        ctx.beginPath();
        ctx.moveTo(s.x - L, s.y); ctx.lineTo(s.x + L, s.y);
        ctx.moveTo(s.x, s.y - L); ctx.lineTo(s.x, s.y + L);
        ctx.stroke();
        ctx.strokeStyle = "rgba(148,160,184,0.06)";
        ctx.lineWidth = 1;
      }
    }
    ctx.globalAlpha = 1;
  }

  layout();
  window.addEventListener("resize", layout);
  // A slow twinkle, skipped when the tab is hidden or motion is unwanted.
  const t0 = performance.now();
  setInterval(() => {
    if (document.hidden || still.matches) return;
    paint((performance.now() - t0) / 1000);
  }, 160);
})();

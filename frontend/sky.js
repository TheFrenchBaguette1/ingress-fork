"use strict";
/* Decorative background only: a deep star field painted once behind the
 * page. Nothing here reads or changes the viewer's state. story.js moves the
 * canvas a little as the page scrolls.
 */
(() => {
  const cv = document.getElementById("sky");
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext("2d");
  // Star colours from hot to cool, kept close to white.
  const TINTS = ["#dfe8ff", "#eef2ff", "#ffffff", "#ffffff", "#fff4e2", "#ffe6c8", "#ffd9b8"];

  // The same sky on every visit: a small seeded generator.
  function seeded(seed) {
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function paint() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#040508";
    ctx.fillRect(0, 0, w, h);
    const rand = seeded(20250311);

    // A band of unresolved starlight crossing the frame, lower left to upper right.
    const ax = -0.05 * w, ay = 0.92 * h, bx = 1.05 * w, by = 0.08 * h;
    const len = Math.hypot(bx - ax, by - ay), nx = -(by - ay) / len, ny = (bx - ax) / len;
    const reach = 0.3 * Math.max(w, h);
    ctx.globalCompositeOperation = "lighter";
    for (let k = 0; k < 11; k++) {
      const u = k / 10 + (rand() - 0.5) * 0.06, off = (rand() - 0.5) * 0.12 * h;
      const x = ax + (bx - ax) * u + nx * off, y = ay + (by - ay) * u + ny * off;
      const r = reach * (0.6 + 0.7 * rand());
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const warm = k % 4 === 1;
      g.addColorStop(0, warm ? "rgba(190,160,140,0.045)" : "rgba(130,150,200,0.05)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }

    // Faint stars, crowded towards the band.
    const sigma = 0.2 * h;
    const faint = Math.min(16000, Math.round((w * h) / 170));
    ctx.fillStyle = "#fff";
    for (let k = 0; k < faint; k++) {
      const x = rand() * w, y = rand() * h;
      const d = ((x - ax) * nx + (y - ay) * ny) / sigma;
      if (rand() > 0.1 + 0.9 * Math.exp(-d * d)) continue;
      ctx.globalAlpha = 0.08 + 0.4 * rand() * rand();
      const s = rand() < 0.85 ? 0.7 : 1.1;
      ctx.fillRect(x, y, s, s);
    }

    // Brighter field stars, a few with a soft glow.
    const bright = Math.min(1400, Math.round((w * h) / 3600));
    for (let k = 0; k < bright; k++) {
      const x = rand() * w, y = rand() * h, m = rand();
      const r = 0.4 + 1.2 * m * m * m * m;
      const tint = TINTS[Math.floor(rand() * TINTS.length)];
      if (r > 1.05) {
        const R = r * (5 + 6 * rand());
        const g = ctx.createRadialGradient(x, y, 0, x, y, R);
        g.addColorStop(0, "rgba(255,255,255,0.22)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.fillRect(x - R, y - R, 2 * R, 2 * R);
      }
      ctx.globalAlpha = 0.45 + 0.55 * rand();
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  paint();
  let wait = null;
  window.addEventListener("resize", () => {
    clearTimeout(wait);
    wait = setTimeout(paint, 150);
  });
})();

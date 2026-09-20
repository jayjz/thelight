#!/usr/bin/env node
/**
 * Compose the LIGHTLIGHT 1200×630 share card in HTML/SVG (exact type)
 * and screenshot it with Playwright. Staged under .grok/, not public/.
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const PAPER = "#dfe3ea";
const STEEL = "#a8b2c1";
const UP = "#6f9e86";
const DOWN = "#c17b74";
const INK = "#08090b";

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function candles(n = 72, seed = 20260919) {
  const rng = mulberry32(seed);
  const out = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const phase = Math.floor(i / (n / 4));
    let drift = 0.0002;
    let vol = 0.009;
    if (phase === 1) {
      drift = 0.0016;
      vol = 0.011;
    } else if (phase === 2) {
      drift = -0.0004;
      vol = 0.018;
    } else if (phase === 3) {
      drift = -0.0012;
      vol = 0.01;
    }
    const ret = drift + vol * gaussian(rng);
    const open = close;
    close = Math.max(40, open * (1 + ret));
    const wick = Math.abs(vol * gaussian(rng)) * open;
    const high = Math.max(open, close) + wick * 0.55;
    const low = Math.min(open, close) - wick * 0.55;
    out.push({ open, high, low, close });
  }
  return out;
}

function candleSvg() {
  const bars = candles();
  const W = 1200;
  const H = 630;
  const padX = 36;
  const bandTop = 338;
  const bandH = 250;
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const maxP = Math.max(...highs);
  const minP = Math.min(...lows);
  const span = maxP - minP || 1;
  const slot = (W - padX * 2) / bars.length;
  const bodyW = Math.max(4.2, slot * 0.55);
  const yOf = (p) => bandTop + (1 - (p - minP) / span) * bandH;

  let d = "";
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const x = padX + slot * i + slot / 2;
    const up = b.close >= b.open;
    const color = up ? UP : DOWN;
    const y1 = yOf(b.high);
    const y2 = yOf(b.low);
    const yt = yOf(Math.max(b.open, b.close));
    const yb = yOf(Math.min(b.open, b.close));
    const bh = Math.max(2.2, yb - yt);
    d += `<line x1="${x.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${color}" stroke-width="1.15" stroke-opacity="0.42"/>`;
    d += `<rect x="${(x - bodyW / 2).toFixed(2)}" y="${yt.toFixed(2)}" width="${bodyW.toFixed(2)}" height="${bh.toFixed(2)}" fill="${color}" fill-opacity="0.34"/>`;
  }

  // Faint sparkline of closes across the quiet mid-field
  const midTop = 96;
  const midH = 200;
  const pts = bars
    .map((b, i) => {
      const x = padX + slot * i + slot / 2;
      const y = midTop + (1 - (b.close - minP) / span) * midH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return `
  <rect width="${W}" height="${H}" fill="${INK}"/>
  <g opacity="0.07" stroke="${STEEL}" stroke-width="1" fill="none">
    ${Array.from({ length: 30 }, (_, i) => `<line x1="${40 * i}" y1="0" x2="${40 * i}" y2="${H}"/>`).join("")}
    ${Array.from({ length: 16 }, (_, i) => `<line x1="0" y1="${40 * i}" x2="${W}" y2="${40 * i}"/>`).join("")}
  </g>
  <polyline points="${pts}" fill="none" stroke="${PAPER}" stroke-width="1.25" stroke-opacity="0.10"/>
  <g>${d}</g>
  `;
}

function cornerTicks() {
  const s = 22;
  const m = 28;
  const w = 1200;
  const h = 630;
  const c = STEEL;
  return `
  <g fill="none" stroke="${c}" stroke-width="1.25" stroke-opacity="0.55">
    <path d="M${m} ${m + s} V${m} H${m + s}"/>
    <path d="M${w - m - s} ${m} H${w - m} V${m + s}"/>
    <path d="M${m} ${h - m - s} V${h - m} H${m + s}"/>
    <path d="M${w - m - s} ${h - m} H${w - m} V${h - m - s}"/>
  </g>`;
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<style>
  @font-face {
    font-family: "LSN";
    src: url("file:///usr/share/fonts/truetype/liberation/LiberationSansNarrow-Bold.ttf") format("truetype");
    font-weight: 700;
    font-style: normal;
  }
  @font-face {
    font-family: "LSN";
    src: url("file:///usr/share/fonts/truetype/liberation/LiberationSansNarrow-Regular.ttf") format("truetype");
    font-weight: 400;
    font-style: normal;
  }
  @font-face {
    font-family: "LM";
    src: url("file:///usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf") format("truetype");
    font-weight: 400;
    font-style: normal;
  }
  html, body {
    margin: 0;
    width: 1200px;
    height: 630px;
    background: ${INK};
    overflow: hidden;
    color: ${PAPER};
  }
  .stage {
    position: relative;
    width: 1200px;
    height: 630px;
  }
  svg.bg {
    position: absolute;
    inset: 0;
  }
  .lockup {
    position: absolute;
    left: 0;
    right: 0;
    top: 168px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
  }
  .mark {
    display: flex;
    gap: 10px;
    margin-bottom: 26px;
  }
  .mark i {
    display: block;
    width: 14px;
    height: 48px;
    background: ${PAPER};
  }
  h1 {
    margin: 0;
    font-family: "LSN", "Liberation Sans Narrow", sans-serif;
    font-weight: 700;
    font-size: 128px;
    line-height: 0.92;
    letter-spacing: 0.05em;
    color: ${PAPER};
    text-indent: 0.05em;
  }
  .rule {
    width: 220px;
    height: 1px;
    background: ${STEEL};
    opacity: 0.55;
    margin: 22px 0 16px;
  }
  .tag {
    margin: 0;
    font-family: "LSN", "Liberation Sans Narrow", sans-serif;
    font-weight: 400;
    font-size: 15px;
    letter-spacing: 0.46em;
    color: ${STEEL};
    text-indent: 0.46em;
  }
  .micro-l, .micro-r {
    position: absolute;
    bottom: 36px;
    font-family: "LM", "Liberation Mono", monospace;
    font-size: 11px;
    letter-spacing: 0.18em;
    color: ${STEEL};
    opacity: 0.78;
  }
  .micro-l { left: 48px; }
  .micro-r { right: 48px; }
  .micro-t {
    position: absolute;
    top: 36px;
    left: 48px;
    right: 48px;
    display: flex;
    justify-content: space-between;
    font-family: "LM", "Liberation Mono", monospace;
    font-size: 11px;
    letter-spacing: 0.18em;
    color: ${STEEL};
    opacity: 0.7;
  }
</style>
</head>
<body>
  <div class="stage">
    <svg class="bg" viewBox="0 0 1200 630" width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      ${candleSvg()}
      ${cornerTicks()}
    </svg>
    <div class="micro-t"><span>RESEARCH TERMINAL</span><span>SPRINT 0</span></div>
    <div class="lockup">
      <div class="mark" aria-hidden="true"><i></i><i></i></div>
      <h1>LIGHTLIGHT</h1>
      <div class="rule"></div>
      <p class="tag">QUANTITATIVE RESEARCH</p>
    </div>
    <div class="micro-l">PAPER REPLAY</div>
    <div class="micro-r">NOT A LIVE-ORDER PATH</div>
  </div>
</body>
</html>
`;

writeFileSync("/workspace/.grok/og-card.html", html);

const browser = await chromium.launch({ args: ["--font-render-hinting=none"] });
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 2,
});
await page.goto("file:///workspace/.grok/og-card.html", { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(120);
await page.screenshot({
  path: "/workspace/.grok/card-raw.png",
  type: "png",
  clip: { x: 0, y: 0, width: 1200, height: 630 },
});

// Favicon raster check at tab size
await page.setViewportSize({ width: 32, height: 32 });
await page.goto("file:///workspace/public/favicon.svg", { waitUntil: "load" });
await page.screenshot({ path: "/workspace/.grok/favicon-32.png", type: "png" });
await page.setViewportSize({ width: 16, height: 16 });
await page.screenshot({ path: "/workspace/.grok/favicon-16.png", type: "png" });

await browser.close();
console.log("composed card-raw.png + favicon rasters");

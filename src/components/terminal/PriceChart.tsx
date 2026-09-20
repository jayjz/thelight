import { useEffect, useRef, type MouseEvent } from "react";
import { THRESHOLDS } from "@/lib/lightlight/thresholds";
import { fmtPx, fmtUtcShort } from "@/lib/lightlight/format";
import { selectEvidence, selectSession, useTerminal } from "@/lib/lightlight/store";

const REGIME_FILL: Record<string, string> = {
  trend_up: "color-mix(in oklab, var(--color-up) 14%, transparent)",
  trend_down: "color-mix(in oklab, var(--color-down) 14%, transparent)",
  mean_reverting: "color-mix(in oklab, var(--color-warn) 12%, transparent)",
  ambiguous: "transparent",
};

export function PriceChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const session = useTerminal(selectSession);
  const cursor = useTerminal((s) => s.cursor);
  const setCursor = useTerminal((s) => s.setCursor);
  const playing = useTerminal((s) => s.playing);
  const togglePlay = useTerminal((s) => s.togglePlay);
  const step = useTerminal((s) => s.step);
  const ev = useTerminal(selectEvidence);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const styles = getComputedStyle(canvas);
      const fg = styles.getPropertyValue("--color-fg").trim() || "#e6e8ee";
      const muted = styles.getPropertyValue("--color-muted").trim() || "#8b919c";
      const up = styles.getPropertyValue("--color-up").trim() || "#6f9e86";
      const down = styles.getPropertyValue("--color-down").trim() || "#c17b74";
      const line = styles.getPropertyValue("--color-line").trim() || "#222";
      const accent = styles.getPropertyValue("--color-accent").trim() || "#b4bcc8";
      const bg = styles.getPropertyValue("--color-surface").trim() || "#0e1014";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const pad = { l: 52, r: 10, t: 8, b: 28 };
      const { candles, evidences } = session;
      const n = candles.length;
      if (n === 0) return;

      const windowSize = Math.min(96, n);
      const start = Math.max(0, Math.min(cursor - windowSize + 12, n - windowSize));
      const end = Math.min(n, start + windowSize);
      const count = end - start;

      const plotW = w - pad.l - pad.r;
      const plotH = h - pad.t - pad.b;
      const volH = plotH * 0.16;
      const priceH = plotH - volH - 6;

      let min = Infinity;
      let max = -Infinity;
      let maxVol = 1;
      for (let i = start; i < end; i++) {
        const c = candles[i]!;
        min = Math.min(min, c.low);
        max = Math.max(max, c.high);
        maxVol = Math.max(maxVol, c.volume);
      }
      const padY = (max - min) * 0.08 || 1;
      min -= padY;
      max += padY;

      const xAt = (i: number) => pad.l + ((i - start + 0.5) / count) * plotW;
      const yAt = (p: number) => pad.t + ((max - p) / (max - min)) * priceH;
      const slot = plotW / count;

      for (let i = start; i < end; i++) {
        const regime = evidences[i]?.jevResponse.answers.REGIME.choice ?? "ambiguous";
        const fill = REGIME_FILL[regime] ?? "transparent";
        if (fill === "transparent") continue;
        ctx.fillStyle = fill;
        ctx.fillRect(pad.l + ((i - start) / count) * plotW, pad.t, slot + 0.5, priceH);
      }

      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, pad.t);
      ctx.lineTo(pad.l, pad.t + priceH);
      ctx.lineTo(pad.l + plotW, pad.t + priceH);
      ctx.stroke();

      ctx.fillStyle = muted;
      ctx.font = "10px IBM Plex Mono, ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let k = 0; k < 4; k++) {
        const p = min + ((max - min) * k) / 3;
        const y = yAt(p);
        ctx.fillText(p.toFixed(1), pad.l - 6, y);
      }

      const candleW = Math.max(2, slot * 0.7);
      for (let i = start; i < end; i++) {
        const c = candles[i]!;
        const x = xAt(i);
        const bull = c.close >= c.open;
        ctx.strokeStyle = bull ? up : down;
        ctx.fillStyle = bull ? up : down;
        ctx.beginPath();
        ctx.moveTo(x, yAt(c.high));
        ctx.lineTo(x, yAt(c.low));
        ctx.stroke();
        const y1 = yAt(Math.max(c.open, c.close));
        const y2 = yAt(Math.min(c.open, c.close));
        ctx.fillRect(x - candleW / 2, y1, candleW, Math.max(1, y2 - y1));
      }

      ctx.beginPath();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.25;
      let started = false;
      for (let i = start; i < end; i++) {
        const ema = evidences[i]?.features.emaPrice;
        if (!ema) continue;
        const x = xAt(i);
        const y = yAt(ema);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();

      for (const fill of session.fills) {
        const i = fill.fillBarIndex;
        if (i < start || i >= end) continue;
        const x = xAt(i);
        const y = yAt(candles[i]!.close);
        ctx.fillStyle = fill.action === "LONG" ? up : fill.action === "SHORT" ? down : muted;
        ctx.beginPath();
        if (fill.action === "LONG") {
          ctx.moveTo(x, y - 7);
          ctx.lineTo(x - 4, y);
          ctx.lineTo(x + 4, y);
        } else if (fill.action === "SHORT") {
          ctx.moveTo(x, y + 7);
          ctx.lineTo(x - 4, y);
          ctx.lineTo(x + 4, y);
        }
        ctx.closePath();
        ctx.fill();
      }

      const volTop = pad.t + priceH + 6;
      for (let i = start; i < end; i++) {
        const c = candles[i]!;
        const x = xAt(i);
        const vh = (c.volume / maxVol) * volH;
        ctx.fillStyle = c.close >= c.open ? up : down;
        ctx.globalAlpha = 0.45;
        ctx.fillRect(x - candleW / 2, volTop + volH - vh, candleW, vh);
        ctx.globalAlpha = 1;
      }

      const cx = xAt(cursor);
      ctx.strokeStyle = fg;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(cx, pad.t);
      ctx.lineTo(cx, pad.t + priceH);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = muted;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(fmtUtcShort(candles[start]!.t), pad.l, h - 16);
      ctx.textAlign = "right";
      ctx.fillText(fmtUtcShort(candles[end - 1]!.t), pad.l + plotW, h - 16);
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [session, cursor]);

  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const padL = 52;
    const padR = 10;
    const n = session.candles.length;
    const windowSize = Math.min(96, n);
    const start = Math.max(0, Math.min(cursor - windowSize + 12, n - windowSize));
    const count = Math.min(n, start + windowSize) - start;
    const i = start + Math.floor(((x - padL) / (rect.width - padL - padR)) * count);
    if (i >= 0 && i < n) setCursor(i);
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-surface">
      <header className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-line px-2">
        <h2 className="kicker">Price</h2>
        <div className="flex items-center gap-2 font-mono text-2xs text-muted">
          <span>EMA {THRESHOLDS.priceEmaSpan}</span>
          <span>cursor {fmtPx(ev?.marketSnapshot.close)}</span>
        </div>
      </header>
      <div className="relative min-h-56 flex-1">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          onClick={onClick}
          role="img"
          aria-label="Candlestick chart of the synthetic replay series"
        />
      </div>
      <div className="flex h-10 shrink-0 items-center gap-1 border-t border-line px-2">
        <button
          type="button"
          className="grid size-8 place-items-center rounded-sm font-mono text-xs text-muted hover:bg-elevated hover:text-fg"
          onClick={() => setCursor(0)}
        >
          {"|<"}
        </button>
        <button
          type="button"
          className="grid size-8 place-items-center rounded-sm font-mono text-xs text-muted hover:bg-elevated hover:text-fg"
          onClick={() => step(-1)}
        >
          {"<"}
        </button>
        <button
          type="button"
          className="h-8 min-w-16 rounded-sm bg-fg px-3 font-mono text-2xs font-medium text-accent-fg active:scale-[0.96]"
          onClick={togglePlay}
        >
          {playing ? "Pause" : "Replay"}
        </button>
        <button
          type="button"
          className="grid size-8 place-items-center rounded-sm font-mono text-xs text-muted hover:bg-elevated hover:text-fg"
          onClick={() => step(1)}
        >
          {">"}
        </button>
        <button
          type="button"
          className="grid size-8 place-items-center rounded-sm font-mono text-xs text-muted hover:bg-elevated hover:text-fg"
          onClick={() => setCursor(session.candles.length - 1)}
        >
          {">|"}
        </button>
        <span className="ml-auto font-mono text-2xs text-subtle">
          {cursor + 1}/{session.candles.length}
        </span>
      </div>
    </section>
  );
}

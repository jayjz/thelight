export function fmtNum(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return x.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const n = x * 100;
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function fmtPx(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return x.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtUtc(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

export function fmtUtcShort(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function signedClass(x: number): string {
  if (!Number.isFinite(x) || x === 0) return "text-muted";
  return x > 0 ? "text-up" : "text-down";
}

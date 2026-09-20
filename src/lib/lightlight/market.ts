import type { ClosedBar } from "./types.ts";

/** Data enters LIGHTLIGHT only as normalized, completed bars. */
export interface MarketSource {
  id: string;
  bars(): AsyncIterable<ClosedBar>;
}

export class SyntheticMarketSource implements MarketSource {
  readonly id = "synthetic-seeded";
  private readonly sourceBars: readonly ClosedBar[];

  constructor(sourceBars: readonly ClosedBar[]) {
    this.sourceBars = sourceBars;
  }

  async *bars(): AsyncIterable<ClosedBar> {
    for (const bar of this.sourceBars) yield { ...bar };
  }
}

/**
 * Produces a larger decision timeframe only after a following bucket proves
 * that the prior one is complete. Raw 1Min bars are preserved upstream.
 */
export async function* aggregateClosedBars(
  source: AsyncIterable<ClosedBar>,
  intervalMinutes: number,
): AsyncIterable<ClosedBar> {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) {
    throw new Error("INVALID_AGGREGATION_INTERVAL");
  }
  let bucket: ClosedBar | undefined;
  let bucketStart = 0;
  const width = intervalMinutes * 60_000;
  for await (const bar of source) {
    const start = Math.floor(bar.t / width) * width;
    if (!bucket || start === bucketStart) {
      bucket = bucket
        ? {
            ...bucket,
            high: Math.max(bucket.high, bar.high),
            low: Math.min(bucket.low, bar.low),
            close: bar.close,
            volume: bucket.volume + bar.volume,
          }
        : { ...bar, t: start };
      bucketStart = start;
      continue;
    }
    yield bucket;
    bucket = { ...bar, t: start };
    bucketStart = start;
  }
}

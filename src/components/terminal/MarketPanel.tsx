import { fmtNum, fmtPct, fmtPx, signedClass } from "@/lib/lightlight/format";
import { selectEvidence, selectSession, useTerminal } from "@/lib/lightlight/store";
import { Kv, Panel } from "./Panel";

export function MarketPanel() {
  const ev = useTerminal(selectEvidence);
  const session = useTerminal(selectSession);
  const cursor = useTerminal((s) => s.cursor);
  const candle = session.candles[cursor];
  const f = ev?.features;
  const first = session.candles[0]?.close ?? 1;
  const ret = candle && first ? candle.close / first - 1 : 0;

  return (
    <Panel title="Market" meta="closed bar">
      <dl className="flex flex-col gap-1.5">
        <Kv k="Last" v={fmtPx(candle?.close)} />
        <Kv
          k="Return"
          v={fmtPct(f?.logReturn)}
          tone={f && f.logReturn > 0 ? "up" : f && f.logReturn < 0 ? "down" : "muted"}
        />
        <div className="flex items-baseline justify-between gap-3">
          <dt className="font-mono text-2xs uppercase tracking-wider text-subtle">Path</dt>
          <dd className={`tabular font-mono text-sm ${signedClass(ret)}`}>{fmtPct(ret)}</dd>
        </div>
        <Kv k="Volume" v={fmtNum(candle?.volume, 0)} />
        <Kv k="Realized vol" v={fmtNum(f?.realizedVol, 4)} />
        <Kv
          k="Drawdown"
          v={fmtPct(f?.drawdown, 2)}
          tone={f && f.drawdown > 0.08 ? "down" : "muted"}
        />
        <Kv k="Norm. return" v={fmtNum(f?.normalizedReturn, 3)} />
        <Kv k="EMA px" v={fmtPx(f?.emaPrice)} />
        <Kv
          k="Disp. EMA"
          v={fmtPct(f?.displacementFromEma, 2)}
          tone={
            f && f.displacementFromEma > 0
              ? "up"
              : f && f.displacementFromEma < 0
                ? "down"
                : "muted"
          }
        />
        <Kv k="s_t (EMA r)" v={fmtNum(f?.emaReturnSignal, 4)} />
        <Kv k="RSI 14" v={fmtNum(f?.rsi14, 2)} />
      </dl>
    </Panel>
  );
}

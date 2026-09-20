import { fmtNum, fmtPct } from "@/lib/lightlight/format";
import { selectSession, useTerminal } from "@/lib/lightlight/store";

export function EvalStrip() {
  const session = useTerminal(selectSession);
  const m = session.metrics;
  const j = session.jevMetrics;
  const cells = [
    ["Return", fmtPct(m.totalReturn)],
    ["Sharpe", fmtNum(m.sharpe, 2)],
    ["Sortino", fmtNum(m.sortino, 2)],
    ["Max DD", fmtPct(m.maxDrawdown)],
    ["Turnover", fmtNum(m.turnover, 3)],
    ["Exposure", fmtNum(m.exposure, 2)],
    ["Cost bps", fmtNum(m.transactionCostBps, 0)],
    ["Slip bps", fmtNum(m.slippageBps, 0)],
    ["Trades", String(m.tradeCount)],
    ["Hit", fmtPct(m.hitRate)],
    ["Abstain", String(m.abstainedCount)],
    ["Brier", fmtNum(j.brierRegime, 3)],
  ];
  return (
    <div className="flex shrink-0 gap-px overflow-x-auto border-t border-line bg-elevated">
      {cells.map(([k, v]) => (
        <div key={k} className="flex min-w-[4.5rem] flex-col px-2 py-1.5">
          <span className="font-mono text-2xs uppercase tracking-wider text-subtle">{k}</span>
          <span className="tabular font-mono text-xs text-fg">{v}</span>
        </div>
      ))}
      <p className="hidden min-w-[16rem] flex-1 px-3 py-1.5 font-mono text-2xs leading-snug text-warn lg:block">
        {m.note}
      </p>
    </div>
  );
}

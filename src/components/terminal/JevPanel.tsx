import { THRESHOLDS } from "@/lib/lightlight/thresholds";
import { fmtNum } from "@/lib/lightlight/format";
import { selectEvidence, useTerminal } from "@/lib/lightlight/store";
import { cn } from "@/lib/utils";
import { Panel } from "./Panel";

function Distro({
  probs,
  chosen,
}: {
  probs: Record<string, number>;
  chosen: string;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {Object.entries(probs).map(([k, p]) => (
        <li key={k} className="flex items-center gap-1">
          <span
            className={cn(
              "w-24 truncate font-mono text-2xs",
              k === chosen ? "text-fg" : "text-muted",
            )}
          >
            {k}
          </span>
          <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-xs bg-elevated">
            <span
              className="block h-full bg-accent"
              style={{ width: `${Math.max(0, Math.min(100, p * 100))}%` }}
            />
          </span>
          <span className="tabular w-9 text-right font-mono text-2xs text-muted">
            {fmtNum(p, 2)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function NoulRow({ label, p, pass }: { label: string; p: number; pass: boolean }) {
  return (
    <div className="flex items-center gap-1">
      <span className="min-w-0 flex-1 font-mono text-2xs text-muted">{label}</span>
      <span className="tabular w-11 text-right font-mono text-xs text-fg">{fmtNum(p, 2)}</span>
      <span
        className={cn(
          "w-12 text-right font-mono text-2xs",
          pass ? "text-up" : "text-subtle",
        )}
      >
        {pass ? "pass" : "hold"}
      </span>
    </div>
  );
}

export function JevPanel() {
  const ev = useTerminal(selectEvidence);
  const a = ev?.jevResponse.answers;
  if (!a || !ev) {
    return (
      <Panel title="Jev" meta="no bar">
        <p className="text-xs text-muted">No closed candle yet.</p>
      </Panel>
    );
  }

  return (
    <Panel title="Jev" meta={`${ev.jevResponse.model} · ${ev.jevResponse.latencyMs} ms`}>
      <div className="flex flex-col gap-3">
        <p className="text-2xs leading-snug text-subtle">
          Typed answers only. Jev does not size, compute indicators, or emit BUY/SELL.
          Active port is a deterministic mock until TypeSafe is wired.
        </p>
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="kicker">Regime choice</span>
            <span className="font-mono text-2xs text-subtle">
              conf {fmtNum(a.REGIME.confidence, 2)}
            </span>
          </div>
          <Distro probs={a.REGIME.probabilities} chosen={a.REGIME.choice} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="kicker">Noul</span>
          <NoulRow
            label="LONG_SETUP"
            p={a.LONG_SETUP.noul}
            pass={a.LONG_SETUP.noul >= THRESHOLDS.longSetupNoul}
          />
          <NoulRow
            label="SHORT_SETUP"
            p={a.SHORT_SETUP.noul}
            pass={a.SHORT_SETUP.noul >= THRESHOLDS.shortSetupNoul}
          />
          <NoulRow
            label="TREND"
            p={a.TREND.noul}
            pass={a.TREND.noul >= THRESHOLDS.trendNoul}
          />
          <NoulRow
            label="MEAN_REVERSION"
            p={a.MEAN_REVERSION.noul}
            pass={a.MEAN_REVERSION.noul >= THRESHOLDS.meanReversionNoul}
          />
        </div>
        <div>
          <span className="kicker">Market quality</span>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="font-mono text-sm text-fg">{a.MARKET_QUALITY.level}</span>
            <span className="tabular font-mono text-2xs text-muted">
              score {fmtNum(a.MARKET_QUALITY.score, 2)} · conf{" "}
              {fmtNum(a.MARKET_QUALITY.confidence, 2)}
            </span>
          </div>
          <Distro
            probs={a.MARKET_QUALITY.probabilities}
            chosen={a.MARKET_QUALITY.level}
          />
        </div>
        <p className="font-mono text-2xs text-warn">Gates {THRESHOLDS.label}</p>
      </div>
    </Panel>
  );
}

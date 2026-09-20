import { THRESHOLDS } from "@/lib/lightlight/thresholds";
import { EXPERIMENT_ARMS, type ExperimentArm, type StrategyId } from "@/lib/lightlight/types";
import { selectEvidence, useTerminal } from "@/lib/lightlight/store";
import { cn } from "@/lib/utils";
import { Panel } from "./Panel";

const STRATEGIES: { id: StrategyId; label: string }[] = [
  { id: "ema_trend", label: "EMA trend" },
  { id: "rsi_mean_reversion", label: "RSI mean-rev" },
];

export function StrategyPanel() {
  const ev = useTerminal(selectEvidence);
  const strategyId = useTerminal((s) => s.strategyId);
  const setStrategy = useTerminal((s) => s.setStrategy);
  const arm = useTerminal((s) => s.arm);
  const setArm = useTerminal((s) => s.setArm);

  return (
    <Panel title="Strategy" meta={ev?.strategyVersion}>
      <div className="flex flex-col gap-2">
        <div className="flex gap-1">
          {STRATEGIES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStrategy(s.id)}
              className={cn(
                "h-8 flex-1 rounded-sm px-2 font-mono text-2xs transition-colors duration-150 ease-out",
                strategyId === s.id
                  ? "bg-fg text-accent-fg"
                  : "bg-elevated text-muted hover:text-fg",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-1 lg:hidden">
          {(["A", "B", "C", "D"] as ExperimentArm[]).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setArm(id)}
              className={cn(
                "h-8 rounded-sm font-mono text-2xs",
                arm === id ? "bg-fg text-accent-fg" : "bg-elevated text-muted",
              )}
            >
              {id}
            </button>
          ))}
        </div>
        <p className="text-2xs leading-snug text-subtle">{EXPERIMENT_ARMS[arm].summary}</p>
        <Gate k="Candidate" v={strategyId === "ema_trend" ? "EMA trend s_t" : "RSI(14) MR"} />
        <Gate k="Det. signal" v={ev?.deterministicSignal.desired ?? "—"} />
        <Gate k="Det. regime" v={ev?.deterministicRegime ?? "—"} />
        <Gate k="Jev gate" v={jevGateLabel(ev?.policy.arm, ev?.action, ev?.policy.reason)} />
        <Gate
          k="Risk gate"
          v={ev?.risk.pass ? "pass" : ev?.risk.reasons[0] ?? "block"}
          warn={ev ? !ev.risk.pass : false}
        />
        <Gate k="Final action" v={ev?.action ?? "—"} strong />
        <p className="font-mono text-2xs text-warn">
          |s|/vol {THRESHOLDS.emaSignalEnterZ} · RSI {THRESHOLDS.rsiOversold}/
          {THRESHOLDS.rsiOverbought} {THRESHOLDS.label}
        </p>
      </div>
    </Panel>
  );
}

function jevGateLabel(
  arm?: ExperimentArm,
  _action?: string,
  reason?: string,
): string {
  if (!arm) return "—";
  if (arm === "A" || arm === "B") return "not used";
  if (arm === "C") return "det. filter (not Jev)";
  return reason?.startsWith("Arm D") ? reason.replace("Arm D: ", "") : "Jev";
}

function Gate({
  k,
  v,
  strong,
  warn,
}: {
  k: string;
  v: string;
  strong?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="font-mono text-2xs uppercase tracking-wider text-subtle">{k}</span>
      <span
        className={cn(
          "w-2/3 text-right font-mono text-2xs leading-snug",
          strong ? "text-fg" : "text-muted",
          warn && "text-warn",
        )}
      >
        {v}
      </span>
    </div>
  );
}

import { selectEvidence, useTerminal } from "@/lib/lightlight/store";
import { cn } from "@/lib/utils";
import { Panel } from "./Panel";

export function DecisionTrace() {
  const ev = useTerminal(selectEvidence);
  const openEvidence = useTerminal((s) => s.openEvidence);
  const steps = ev
    ? [
        { k: "candle closed", v: ev.id },
        {
          k: "features computed",
          v: `s_t ${ev.features.emaReturnSignal.toFixed(3)} · RSI ${Number.isFinite(ev.features.rsi14) ? ev.features.rsi14.toFixed(1) : "—"}`,
        },
        { k: "deterministic signal", v: ev.deterministicSignal.desired },
        { k: "Jev request", v: ev.jevRequest.model },
        {
          k: "Jev response",
          v: `${ev.jevResponse.answers.REGIME.choice} · L ${ev.jevResponse.answers.LONG_SETUP.noul.toFixed(2)} S ${ev.jevResponse.answers.SHORT_SETUP.noul.toFixed(2)}`,
        },
        { k: "policy evaluation", v: ev.policy.desired },
        { k: "risk evaluation", v: ev.risk.target },
        {
          k: "action / abstention",
          v: ev.abstained && ev.action === "FLAT" ? "ABSTAIN → FLAT" : ev.action,
        },
      ]
    : [];

  return (
    <Panel title="Decision trace" meta={ev?.id}>
      <ol className="flex flex-col">
        {steps.map((s, i) => (
          <li key={s.k} className="grid grid-cols-[16px_1fr] gap-2">
            <span className="flex flex-col items-center">
              <span
                className={cn(
                  "mt-1 size-1.5 rounded-full",
                  i === steps.length - 1 ? "bg-fg" : "bg-muted",
                )}
              />
              {i < steps.length - 1 ? <span className="w-px flex-1 bg-line" /> : null}
            </span>
            <div className={cn("pb-2", i === steps.length - 1 && "pb-0")}>
              <div className="font-mono text-2xs uppercase tracking-wider text-subtle">
                {s.k}
              </div>
              <div className="truncate font-mono text-xs text-fg">{s.v}</div>
            </div>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => openEvidence()}
        className="mt-3 h-8 w-full rounded-sm bg-elevated font-mono text-2xs text-fg ring-1 ring-line-strong hover:bg-bg"
      >
        Inspect evidence
      </button>
    </Panel>
  );
}

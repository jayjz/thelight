import { EXPERIMENT_ARMS, type ExperimentArm } from "@/lib/lightlight/types";
import { fmtUtc } from "@/lib/lightlight/format";
import { selectEvidence, useTerminal } from "@/lib/lightlight/store";
import { useLightlightRuntimeStatus } from "@/lib/lightlight/runtime";
import { cn } from "@/lib/utils";

const ARMS: ExperimentArm[] = ["A", "B", "C", "D"];

export function TopBar() {
  const arm = useTerminal((s) => s.arm);
  const setArm = useTerminal((s) => s.setArm);
  const toggleHelp = useTerminal((s) => s.toggleHelp);
  const ev = useTerminal(selectEvidence);
  const runtime = useLightlightRuntimeStatus();
  const ts = ev?.timestamp ?? 0;

  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-elevated px-2 text-xs md:gap-3 md:px-3">
      <div className="flex items-center gap-2 pr-2">
        <span
          className="grid size-5 place-items-center rounded-xs bg-fg font-mono text-2xs font-semibold text-accent-fg"
          aria-hidden
        >
          LL
        </span>
        <span className="font-sans text-sm font-semibold tracking-tight">LIGHTLIGHT</span>
      </div>

      <span className="hidden h-4 w-px bg-line-strong sm:block" />

      <div className="flex items-center gap-2 font-mono text-2xs md:text-xs">
        <span className="text-fg">{runtime.symbol}</span>
        <span className="text-subtle">{runtime.mode === "ALPACA_PAPER" ? "1Min" : "1D"}</span>
        <span className="rounded-xs bg-elevated px-1.5 py-0.5 text-warn ring-1 ring-line-strong">
          {runtime.mode === "ALPACA_PAPER" ? "ALPACA PAPER" : "SYNTHETIC"}
        </span>
        <span className="rounded-xs bg-paper/15 px-1.5 py-0.5 text-paper ring-1 ring-paper/30">
          PAPER
        </span>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto md:gap-2">
        <div className="mr-1 hidden items-center gap-1 lg:flex">
          {ARMS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setArm(id)}
              className={cn(
                "h-8 min-w-8 rounded-sm px-2 font-mono text-2xs tracking-wide transition-colors duration-150 ease-out active:scale-[0.96]",
                arm === id
                  ? "bg-fg text-accent-fg"
                  : "text-muted hover:bg-surface hover:text-fg",
              )}
              title={EXPERIMENT_ARMS[id].label}
            >
              {id}
            </button>
          ))}
        </div>
        <span className="hidden font-mono text-2xs text-subtle xl:inline">
          {EXPERIMENT_ARMS[arm].label}
        </span>
        <time
          className="tabular font-mono text-2xs text-muted md:text-xs"
          dateTime={ts ? fmtUtc(ts) : undefined}
        >
          {ts ? fmtUtc(ts) : "—"}
        </time>
        <button
          type="button"
          onClick={toggleHelp}
          className="grid size-10 place-items-center rounded-sm text-muted hover:bg-surface hover:text-fg"
          aria-label="Keyboard shortcuts"
        >
          ?
        </button>
      </div>
    </header>
  );
}

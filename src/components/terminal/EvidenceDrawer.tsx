import { fmtUtc } from "@/lib/lightlight/format";
import { selectById, useTerminal } from "@/lib/lightlight/store";

export function EvidenceDrawer() {
  const open = useTerminal((s) => s.evidenceOpen);
  const close = useTerminal((s) => s.closeEvidence);
  const selectedId = useTerminal((s) => s.selectedId);
  const ev = useTerminal((s) => selectById(s, s.selectedId));
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-end bg-bg/70 md:items-stretch">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close evidence"
        onClick={close}
      />
      <aside className="relative z-10 flex h-5/6 w-full max-w-xl flex-col border-l border-line bg-elevated shadow-[0_0_0_1px_rgba(255,255,255,0.08)] md:h-full">
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-line px-3">
          <div>
            <div className="kicker">Evidence</div>
            <div className="font-mono text-xs text-fg">{selectedId}</div>
          </div>
          <button
            type="button"
            onClick={close}
            className="grid size-8 place-items-center rounded-sm text-muted hover:bg-surface hover:text-fg"
          >
            Esc
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {ev ? (
            <div className="flex flex-col gap-2">
              <p className="font-mono text-2xs text-subtle">
                {fmtUtc(ev.timestamp)} · {ev.symbol} {ev.timeframe} · {ev.tradingMode}
              </p>
              <pre className="overflow-x-auto rounded-sm bg-bg p-3 font-mono text-2xs leading-snug text-muted">
                {JSON.stringify(
                  {
                    id: ev.id,
                    timestamp: ev.timestamp,
                    symbol: ev.symbol,
                    timeframe: ev.timeframe,
                    marketSnapshot: ev.marketSnapshot,
                    featureValues: ev.features,
                    strategy: {
                      id: ev.strategyId,
                      version: ev.strategyVersion,
                    },
                    jevRequest: ev.jevRequest,
                    jevResponse: ev.jevResponse,
                    policy: ev.policy,
                    risk: ev.risk,
                    resultingAction: ev.action,
                    researchReferences: ev.researchRefs,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          ) : (
            <p className="text-sm text-muted">No evidence object for this cursor.</p>
          )}
        </div>
      </aside>
    </div>
  );
}

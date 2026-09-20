import { useEffect } from "react";
import { useTerminal } from "@/lib/lightlight/store";
import { useLightlightRuntimeStatus } from "@/lib/lightlight/runtime";
import { DecisionTrace } from "./DecisionTrace";
import { EvalStrip } from "./EvalStrip";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { JevPanel } from "./JevPanel";
import { KeyboardHelp } from "./KeyboardHelp";
import { MarketPanel } from "./MarketPanel";
import { PriceChart } from "./PriceChart";
import { ResearchPanel } from "./ResearchPanel";
import { StrategyPanel } from "./StrategyPanel";
import { TopBar } from "./TopBar";
import { cn } from "@/lib/utils";

export function Terminal() {
  const runtime = useLightlightRuntimeStatus();
  const playing = useTerminal((s) => s.playing);
  const step = useTerminal((s) => s.step);
  const setCursor = useTerminal((s) => s.setCursor);
  const setArm = useTerminal((s) => s.setArm);
  const setStrategy = useTerminal((s) => s.setStrategy);
  const strategyId = useTerminal((s) => s.strategyId);
  const togglePlay = useTerminal((s) => s.togglePlay);
  const toggleHelp = useTerminal((s) => s.toggleHelp);
  const helpOpen = useTerminal((s) => s.helpOpen);
  const evidenceOpen = useTerminal((s) => s.evidenceOpen);
  const closeEvidence = useTerminal((s) => s.closeEvidence);
  const openEvidence = useTerminal((s) => s.openEvidence);
  const mobileTab = useTerminal((s) => s.mobileTab);
  const setMobileTab = useTerminal((s) => s.setMobileTab);
  const n = useTerminal((s) => s.sessions[s.arm].candles.length);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const state = useTerminal.getState();
      const last = state.sessions[state.arm].candles.length - 1;
      if (state.cursor >= last) {
        state.setPlaying(false);
        return;
      }
      state.step(1);
    }, 140);
    return () => window.clearInterval(id);
  }, [playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        toggleHelp();
        return;
      }
      if (e.key === "Escape") {
        if (helpOpen) toggleHelp();
        if (evidenceOpen) closeEvidence();
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      }
      if (e.key === "Home") {
        e.preventDefault();
        setCursor(0);
      }
      if (e.key === "End") {
        e.preventDefault();
        setCursor(n - 1);
      }
      if (e.key === "1") setArm("A");
      if (e.key === "2") setArm("B");
      if (e.key === "3") setArm("C");
      if (e.key === "4") setArm("D");
      if (e.key === "s" || e.key === "S") {
        setStrategy(strategyId === "ema_trend" ? "rsi_mean_reversion" : "ema_trend");
      }
      if (e.key === "e" || e.key === "E") openEvidence();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    closeEvidence,
    evidenceOpen,
    helpOpen,
    n,
    openEvidence,
    setArm,
    setCursor,
    setStrategy,
    step,
    strategyId,
    toggleHelp,
    togglePlay,
  ]);

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-bg text-fg">
      <TopBar />
      {runtime.mode === "ALPACA_PAPER" ? (
        <main className="flex min-h-0 flex-1 items-center justify-center p-5">
          <section className="w-full max-w-2xl border border-line bg-surface p-5 font-mono text-xs">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h1 className="text-sm font-semibold text-fg">ALPACA PAPER</h1>
              <span className="rounded-sm bg-elevated px-2 py-1 text-warn">{runtime.connectionState}</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-muted sm:grid-cols-3">
              <div><dt className="text-2xs uppercase text-subtle">Symbol</dt><dd>{runtime.symbol}</dd></div>
              <div><dt className="text-2xs uppercase text-subtle">Feed</dt><dd>{runtime.feed}</dd></div>
              <div><dt className="text-2xs uppercase text-subtle">Closed bar</dt><dd>{runtime.latestClosedBarTimestamp ?? "—"}</dd></div>
              <div><dt className="text-2xs uppercase text-subtle">Decision</dt><dd>{runtime.latestDecisionId ?? "—"}</dd></div>
              <div><dt className="text-2xs uppercase text-subtle">Broker order</dt><dd>{runtime.latestBrokerOrderState ?? "—"}</dd></div>
              <div><dt className="text-2xs uppercase text-subtle">Position</dt><dd>{runtime.currentPaperPosition ?? "—"}</dd></div>
              <div><dt className="text-2xs uppercase text-subtle">Jev adapter</dt><dd>{runtime.jevAdapter}</dd></div>
              <div><dt className="text-2xs uppercase text-subtle">Jev model</dt><dd>{runtime.jevModel}</dd></div>
            </dl>
            <p className="mt-5 border-t border-line pt-3 leading-relaxed text-warn">
              {runtime.error ?? "Backend paper runtime is connected. Only closed bars may produce decisions; broker updates remain separate from decision evidence."}
            </p>
          </section>
        </main>
      ) : <>
      <p className="shrink-0 border-b border-line bg-surface px-3 py-1 font-mono text-2xs text-warn">
        PAPER / REPLAY ONLY · synthetic seeded series · Jev port is a mock · not a live
        model, not a broker, not a performance claim
      </p>
      <div className="hidden min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)_280px] grid-rows-[minmax(0,1fr)_minmax(200px,240px)] lg:grid [&>*]:min-h-0 [&>*]:min-w-0 [&>*]:border-r [&>*]:border-b [&>*]:border-line">
        <MarketPanel />
        <PriceChart />
        <JevPanel />
        <StrategyPanel />
        <DecisionTrace />
        <ResearchPanel />
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className={cn("h-full", mobileTab !== "chart" && "hidden")}>
            <div className="grid h-full grid-rows-[minmax(0,1fr)_auto]">
              <PriceChart />
              <div className="max-h-40 overflow-auto border-t border-line">
                <MarketPanel />
              </div>
            </div>
          </div>
          <div className={cn("h-full", mobileTab !== "jev" && "hidden")}>
            <JevPanel />
          </div>
          <div className={cn("h-full", mobileTab !== "trace" && "hidden")}>
            <div className="grid h-full grid-rows-2">
              <StrategyPanel />
              <DecisionTrace />
            </div>
          </div>
          <div className={cn("h-full", mobileTab !== "research" && "hidden")}>
            <ResearchPanel />
          </div>
        </div>
        <nav className="grid h-12 shrink-0 grid-cols-4 border-t border-line bg-elevated">
          {(["chart", "jev", "trace", "research"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setMobileTab(tab)}
              className={cn(
                "font-mono text-2xs uppercase tracking-wider",
                mobileTab === tab ? "text-fg" : "text-subtle",
              )}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>
      <EvalStrip />
      <EvidenceDrawer />
      <KeyboardHelp />
      </>}
    </div>
  );
}

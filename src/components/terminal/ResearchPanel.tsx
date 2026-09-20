import { RESEARCH, cardForStrategy } from "@/lib/lightlight/research";
import { fmtNum, fmtPct } from "@/lib/lightlight/format";
import { selectSession, useTerminal } from "@/lib/lightlight/store";
import { EXPERIMENT_ARMS, type ExperimentArm } from "@/lib/lightlight/types";
import { Panel } from "./Panel";

export function ResearchPanel() {
  const strategyId = useTerminal((s) => s.strategyId);
  const arm = useTerminal((s) => s.arm);
  const sessions = useTerminal((s) => s.sessions);
  const session = useTerminal(selectSession);
  const card = cardForStrategy(strategyId);
  const evalCard = RESEARCH.evaluation!;

  return (
    <Panel title="Research" meta={`arXiv:${card.paper.arxiv}`}>
      <div className="flex flex-col gap-3 text-xs leading-snug">
        <div>
          <div className="kicker">Paper</div>
          <p className="mt-1 text-fg">
            {card.paper.authors} ({card.paper.year}). {card.paper.title}.
          </p>
        </div>
        <Block label="Research hypothesis" body={card.hypothesis} />
        <Block label="Our implementation" body={card.implementation} />
        <Block
          label="Observed result"
          body={`${card.observed} This arm ${arm} (${EXPERIMENT_ARMS[arm].label}): total return ${fmtPct(session.metrics.totalReturn)} · Sharpe ${fmtNum(session.metrics.sharpe, 2)} · max DD ${fmtPct(session.metrics.maxDrawdown)} · trades ${session.metrics.tradeCount}.`}
        />
        <div>
          <div className="kicker">Arm comparison · synthetic in-sample</div>
          <table className="mt-1 w-full font-mono text-2xs">
            <thead className="text-subtle">
              <tr>
                <th className="py-1 text-left font-medium">Arm</th>
                <th className="text-right font-medium">Ret</th>
                <th className="text-right font-medium">Sh</th>
                <th className="text-right font-medium">DD</th>
                <th className="text-right font-medium">N</th>
              </tr>
            </thead>
            <tbody>
              {(["A", "B", "C", "D"] as ExperimentArm[]).map((id) => {
                const m = sessions[id].metrics;
                return (
                  <tr key={id} className={id === arm ? "text-fg" : "text-muted"}>
                    <td className="py-0.5">{id}</td>
                    <td className="tabular text-right">{fmtPct(m.totalReturn, 1)}</td>
                    <td className="tabular text-right">{fmtNum(m.sharpe, 2)}</td>
                    <td className="tabular text-right">{fmtPct(m.maxDrawdown, 1)}</td>
                    <td className="tabular text-right">{m.tradeCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Block label="Evaluation method (deferred)" body={evalCard.implementation} />
      </div>
    </Panel>
  );
}

function Block({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <div className="kicker">{label}</div>
      <p className="mt-1 text-pretty text-muted">{body}</p>
    </div>
  );
}

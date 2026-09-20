import type {
  Action,
  Candle,
  EquityPoint,
  ExecutionIntent,
  ExecutionLedger,
  Fill,
  PositionTransition,
} from "./types.ts";

export const REPLAY_EXECUTION_MODEL = "NEXT_BAR_CLOSE" as const;

export type ReplayExecutionConfig = {
  transactionCostBps: number;
  slippageBps: number;
};

export function actionToPosition(action: Action): number {
  if (action === "LONG") return 1;
  if (action === "SHORT") return -1;
  return 0;
}

/**
 * The sole replay accounting authority. It accrues the position that existed
 * over an interval first, then applies a next-bar-close transition. This makes
 * a decision after bar t ineligible for t→t+1 economic exposure.
 */
export class ReplayExecution {
  private readonly config: ReplayExecutionConfig;
  private position = 0;
  private equityValue = 1;
  private readonly intents: ExecutionIntent[] = [];
  private readonly fills: Fill[] = [];
  private readonly transitions: PositionTransition[] = [];
  private readonly equity: EquityPoint[] = [];

  constructor(config: ReplayExecutionConfig) {
    this.config = config;
  }

  advanceBar(barIndex: number, candle: Candle, previous?: Candle): void {
    const positionApplied = this.position;
    const marketReturn = previous
      ? positionApplied * Math.log(candle.close / previous.close)
      : 0;
    let transactionCost = 0;
    let slippage = 0;

    // Fills occur after the interval ending at this close. Thus a fill here
    // affects only intervals that begin after this bar.
    for (const intent of this.intents) {
      if (intent.status !== "PENDING" || intent.createdAtBar + 1 !== barIndex) continue;
      const before = this.position;
      const after = intent.desiredPosition;
      const turnover = Math.abs(after - before);
      if (turnover === 0) {
        intent.status = "CANCELLED";
        continue;
      }
      transactionCost += turnover * (this.config.transactionCostBps / 10_000);
      slippage += turnover * (this.config.slippageBps / 10_000);
      const direction = after > before ? 1 : -1;
      const fill: Fill = {
        fillId: `${intent.intentId}:fill`,
        intentId: intent.intentId,
        decisionId: intent.decisionId,
        fillBarIndex: barIndex,
        fillTimestamp: candle.t,
        // Informational execution price. Its economic impact is represented by
        // the single slippage debit below, not a duplicated P&L adjustment.
        fillPrice: candle.close * (1 + direction * (this.config.slippageBps / 10_000)),
        positionBefore: before,
        positionAfter: after,
        transactionCost: turnover * (this.config.transactionCostBps / 10_000),
        slippage: turnover * (this.config.slippageBps / 10_000),
        action: intent.desiredAction,
        status: "FILLED",
      };
      this.fills.push(fill);
      this.transitions.push({
        transitionId: `${intent.intentId}:transition`,
        intentId: intent.intentId,
        decisionId: intent.decisionId,
        barIndex,
        timestamp: candle.t,
        positionBefore: before,
        positionAfter: after,
        turnover,
      });
      intent.status = "FILLED";
      this.position = after;
    }

    const periodReturn = marketReturn - transactionCost - slippage;
    this.equityValue *= Math.exp(periodReturn);
    this.equity.push({
      barIndex,
      timestamp: candle.t,
      equity: this.equityValue,
      periodReturn,
      positionApplied,
      transactionCost,
      slippage,
    });
  }

  createIntent(input: {
    decisionId: string;
    createdAtBar: number;
    createdAtTimestamp: number;
    action: Action;
  }): ExecutionIntent | null {
    const desiredPosition = actionToPosition(input.action);
    if (desiredPosition === this.position) return null;
    const intent: ExecutionIntent = {
      intentId: `${input.decisionId}:intent`,
      decisionId: input.decisionId,
      createdAtBar: input.createdAtBar,
      createdAtTimestamp: input.createdAtTimestamp,
      desiredAction: input.action,
      desiredPosition,
      status: "PENDING",
      executionModel: REPLAY_EXECUTION_MODEL,
    };
    this.intents.push(intent);
    return intent;
  }

  get currentEquity(): number {
    return this.equityValue;
  }

  get currentPosition(): number {
    return this.position;
  }

  get currentDrawdown(): number {
    const peak = this.equity.reduce((max, point) => Math.max(max, point.equity), 1);
    return peak === 0 ? 0 : Math.max(0, (peak - this.equityValue) / peak);
  }

  snapshot(): ExecutionLedger {
    return {
      model: REPLAY_EXECUTION_MODEL,
      intents: this.intents.map((intent) => ({ ...intent })),
      fills: this.fills.map((fill) => ({ ...fill })),
      transitions: this.transitions.map((transition) => ({ ...transition })),
      equity: this.equity.map((point: EquityPoint) => ({ ...point })),
      finalPosition: this.position,
      finalEquity: this.equityValue,
      totalTransactionCost: this.fills.reduce((sum, fill) => sum + fill.transactionCost, 0),
      totalSlippage: this.fills.reduce((sum, fill) => sum + fill.slippage, 0),
    };
  }
}

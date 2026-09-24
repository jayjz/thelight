# EMA/RSI V2 prospective experiment (2026-09-24)

Status: frozen research candidate, UNCALIBRATED, no broker registration. V1 is
an immutable control. September 22 and September 23 were examined before V2
was frozen. Therefore they are not final holdout evidence.

Hypothesis: require evidence that an EMA crossover has meaningful strength and
persistence before changing position, reducing short-horizon whipsaw.

## Exact candidate: ema_rsi_v2 / v2

Long/flat, completed 1Min regular-session bars only. Reset feature continuity on
missing minutes or a new session. Each feature point uses at most the last 23
bars, matching the audited V1 PAPER finite-window EMA seed. EMA9 and EMA21 use
recursive first-close seeding; RSI14 uses the existing SMA gains/losses formula.
Volatility is the existing 20-observation sample standard deviation of log
returns (computeFeatures; its first return is zero). Scale = close * realizedVol.
Signed strength = (EMA9 - EMA21) / scale. Zero/nonfinite scale blocks entry and
is reported explicitly; no division-by-zero infinity is admitted.

* Entry from flat: EMA9 > EMA21, RSI14 > 50 and signed strength >= 0.5 on **two
  consecutive** completed feature points, both with 21-bar warmup. First possible
  entry needs 22 continuous bars.
* Exit from long: signed strength <= -0.25 with valid scale, OR RSI14 < 45.
* Otherwise retain prior target. No short, cooldown, minimum hold, optimizer,
  alternate thresholds, or forced session-end liquidation.

Constants are PROSPECTIVE / UNCALIBRATED. 0.5 is half a one-minute realized price
standard deviation, a dimensionless noise-relative floor, not a statistical
significance threshold. Two bars are the smallest persistence requirement that
rejects a one-bar event. The -0.25 exit boundary is half the entry magnitude:
weaker trend invalidation creates hysteresis without delaying RSI deterioration.
RSI 50/45 and feature definitions come from V1. This combination targets weak
entry, transient entry and microscopic negative crossing separately. No value
was chosen by September P&L or a parameter search. No ATR is introduced.

## Evaluation freeze

Development/diagnostic sessions: 2026-09-22 and 2026-09-23 only. Run V1 and V2
on identical frozen bars and decision opportunities, starting flat, with the
same feature-continuity rules and existing ReplayExecution NEXT_BAR_CLOSE
accounting. This is strategy-only counterfactual research, not broker/risk
execution parity. Keep live risk-approved parity as a separate audit. Freeze
fees/slippage bps per unit turnover at (0,0), (0,1), (0,5), (1,5). Report gross
and net separately; do not select the favorable cost scenario.

Next PAPER session runs **unchanged V1**, retaining bars, decisions, trade updates
and reconciliation evidence. V2 remains offline shadow research. Do not enable
V2 broker dispatch in this change. Export each session with its run ID and
hashes; preserve failed/incomplete sessions and their reasons.

Validation cohort: the first 10 complete, previously uninspected regular SPY
PAPER sessions whose bars begin after this specification's commit. Analyze the
cohort once, after collection; operational completeness checks may run daily,
but no daily parameter revision or outcome-based exclusion. Any rule change is
V3 and needs a new future cohort. Require complete captured decision parity,
no unexplained missing regular minutes within the recorded decision interval,
and at least 20 V1 entries across the cohort; otherwise INCONCLUSIVE.

Primary success: at least 25% fewer total transitions AND at least 50% fewer
weak entries (entry signed strength < 0.5), using fixed NEXT_BAR_CLOSE ledgers.
A zero-trade strategy is not success: require V2 exposure >= 25% of V1 exposure
and >= 5 V2 entries across the cohort. These are prospective operational
criteria, not calibrated significance tests. Failure to meet them is a failed
turnover hypothesis; do not rescue it using P&L. Report per-session counts and
aggregate counts, holds, flips, turnover, exposure, drawdown, gross/net returns
and all cost scenarios regardless of outcome. Profitability is not an acceptance
criterion. No Sharpe inference from two development days.

## Known limitations and literature

The finite 23-bar EMA reseeding can change crossover state as the oldest bar
rolls out. Preserve it for the control; do not silently substitute full-history
EMA. Durable worker runs do not record source revision/configuration hash.
Broker position snapshots are symbol scoped, not run scoped. Trade-update fills
are richer than broker_orders (which omit prices). Partial/censored evidence
must not become an exact session P&L claim. IEX bars need not equal broker
execution prices. NEXT_BAR_CLOSE is a placeholder and differs from observed
PAPER fills near the beginning of the next minute. Signal parity alone cannot
validate that model. Cost scenarios are assumptions, not calibrated quotes.

Aït-Sahalia, Mykland and Zhang, [How Often to Sample a Continuous-Time Process in
the Presence of Market Microstructure Noise](https://www.princeton.edu/~yacine/research)
(RFS, 2005), motivates caution about noisy short-horizon observations; it does
not validate this EMA rule or establish the cause of these losses.
Bailey et al., [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)
motivates retaining unsuccessful experiments and avoiding repeated selection.
Neither paper calibrates our constants. The empirical diagnosis is correlation,
not proof of microstructure causation or positive expectancy.

import { i as __toESM } from "../_runtime.mjs";
import { L as require_react, v as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
import { t as create } from "../_libs/zustand.mjs";
import { t as clsx } from "../_libs/clsx.mjs";
import { t as twMerge } from "../_libs/tailwind-merge.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes-X5b_OyBz.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
/** Sprint 0 trading mode. There is no live-order path. */
var TRADING_MODE = "PAPER_REPLAY";
var SYMBOL = "SYN.LL1";
var EXPERIMENT_ARMS = {
	A: {
		label: "Baseline",
		summary: "Buy-and-hold unit long. Comparison arm, not a researched edge."
	},
	B: {
		label: "Deterministic strategy",
		summary: "Strategy signal only. No regime filter."
	},
	C: {
		label: "Det. strategy + det. regime",
		summary: "Strategy signal gated by our deterministic regime classifier."
	},
	D: {
		label: "Det. strategy + Jev regime",
		summary: "Strategy signal gated by Jev typed answers. Sprint 0 uses a mock adapter."
	}
};
/** Deterministic PRNG. Same seed ⇒ same path. */
function mulberry32(seed) {
	let s = seed >>> 0;
	return () => {
		s = s + 1831565813 >>> 0;
		let t = s;
		t = Math.imul(t ^ t >>> 15, t | 1);
		t ^= t + Math.imul(t ^ t >>> 7, t | 61);
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}
function gaussian(rng) {
	const u = Math.max(rng(), Number.EPSILON);
	const v = rng();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function nextBusinessDayUtc(ms) {
	const d = new Date(ms);
	d.setUTCDate(d.getUTCDate() + 1);
	const day = d.getUTCDay();
	if (day === 6) d.setUTCDate(d.getUTCDate() + 2);
	if (day === 0) d.setUTCDate(d.getUTCDate() + 1);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 21, 0, 0);
}
var SYNTHETIC_SEED = 20260919;
var SYNTHETIC_START_UTC = Date.UTC(2024, 0, 2, 21, 0, 0);
/**
* Seeded synthetic OHLCV with four visual regimes so the terminal can
* demonstrate gating. This is NOT market data. Do not evaluate as a backtest
* of a listed instrument.
*/
function generateSyntheticCandles(seed = SYNTHETIC_SEED, bars = 320) {
	const rng = mulberry32(seed);
	const candles = [];
	let t = SYNTHETIC_START_UTC;
	let price = 100;
	let prevClose = 100;
	for (let i = 0; i < bars; i++) {
		const phase = Math.floor(i / 80);
		let drift = 0;
		let vol = .011;
		let meanRevert = 0;
		if (phase === 0) {
			drift = 2e-4;
			vol = .008;
		} else if (phase === 1) {
			drift = .0018;
			vol = .01;
		} else if (phase === 2) {
			drift = 0;
			vol = .009;
			meanRevert = .12;
		} else {
			drift = -.0015;
			vol = .014;
		}
		const shock = vol * gaussian(rng);
		const pull = meanRevert > 0 ? -meanRevert * Math.log(price / 108) : 0;
		const r = drift + pull + shock;
		const close = prevClose * Math.exp(r);
		const wick = vol * (.4 + rng()) * prevClose;
		const open = prevClose * (1 + (rng() - .5) * vol * .3);
		const high = Math.max(open, close) + Math.abs(wick) * rng();
		const low = Math.min(open, close) - Math.abs(wick) * rng();
		const volume = Math.round(12e5 * (1 + 8 * Math.abs(r)) * (.7 + rng()));
		candles.push({
			t,
			open,
			high: Math.max(high, open, close),
			low: Math.min(low, open, close),
			close,
			volume
		});
		prevClose = close;
		price = close;
		t = nextBusinessDayUtc(t);
	}
	return candles;
}
/**
* All numeric policy cutoffs are UNCALIBRATED until measured on a declared
* walk-forward design (see Mroziewicz & Ślepaczuk, arXiv:2602.10785).
* Do not treat these as paper findings.
*/
var THRESHOLDS = {
	label: "UNCALIBRATED",
	/** Inverse timescale η for Grebenkov return-EMA signal. Illustrative 20-bar. */
	emaEta: .05,
	/** Price EMA span in bars (overlay + displacement). */
	priceEmaSpan: 20,
	/** Rolling window for realized vol and return z-score. */
	volWindow: 20,
	/** Khaidem et al. write RSI over 14 days. */
	rsiPeriod: 14,
	/**
	* Minimum |s_t| / realized_vol to take an EMA-trend position.
	* Grebenkov scales γ so s has unit variance when returns are standardized.
	* Our r_t are raw log returns, so we compare s to local vol. UNCALIBRATED.
	*/
	emaSignalEnterZ: 1,
	/**
	* Conventional RSI bands. Not specified as a trading rule in the cited papers.
	* Khaidem uses RSI as a random-forest feature, not an oversold/overbought gate.
	*/
	rsiOversold: 30,
	rsiOverbought: 70,
	/** Daily log-return std above which new risk is blocked. */
	maxRealizedVol: .035,
	/** Close drawdown from peak that forces flatten. */
	maxDrawdown: .18,
	/** Noul floors for Jev setup / environment gates. */
	longSetupNoul: .55,
	shortSetupNoul: .55,
	trendNoul: .55,
	meanReversionNoul: .55,
	/** Minimum MARKET_QUALITY level (ordered) to allow entry. */
	minQuality: "usable",
	/** Choice confidence floor for using Jev REGIME. */
	regimeConfidence: .35,
	/** Paper transaction cost applied on |Δposition|. 0 until calibrated. */
	transactionCostBps: 0,
	slippageBps: 0,
	/** Bars of future return used as a regime outcome proxy for Brier (ours). */
	regimeOutcomeHorizon: 5
};
var STRATEGY_VERSION = "sprint0.1";
var POLICY_VERSION = "sprint0.1";
var RISK_VERSION = "sprint0.1";
function logReturn(prevClose, close) {
	if (prevClose <= 0 || close <= 0) return 0;
	return Math.log(close / prevClose);
}
function mean(xs) {
	if (xs.length === 0) return 0;
	let s = 0;
	for (const x of xs) s += x;
	return s / xs.length;
}
function sampleStd(xs) {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	let v = 0;
	for (const x of xs) {
		const d = x - m;
		v += d * d;
	}
	return Math.sqrt(v / (xs.length - 1));
}
/**
* Recursive EMA: tilde_x_t = (1-λ) tilde_x_{t-1} + λ x_t
* Grebenkov & Serror eq. (1) recurrent form, arXiv:1308.5658.
* Seeds at the first observation (finite-sample start; paper also writes a
* matrix form over a finite window).
*/
function recursiveEma(values, lambda) {
	if (values.length === 0) return [];
	if (!(lambda > 0 && lambda <= 1)) throw new Error("EMA lambda must be in (0, 1]");
	const out = new Array(values.length);
	out[0] = values[0];
	const oneMinus = 1 - lambda;
	for (let i = 1; i < values.length; i++) out[i] = oneMinus * out[i - 1] + lambda * values[i];
	return out;
}
/**
* Grebenkov & Serror (arXiv:1308.5658) eq. (13):
*   s_t = γ Σ_{k=1}^{t-1} (1-η)^{t-1-k} r_k
* with γ² = η(2-η) so the signal has unit variance for independent returns.
* Recurrence: u_1 = 0; u_t = r_{t-1} + (1-η) u_{t-1}; s_t = γ u_t.
* Uses only past returns — s_t does not include r_t.
*/
function grebenkovReturnSignal(logReturns, eta) {
	if (!(eta > 0 && eta <= 1)) throw new Error("eta must be in (0, 1]");
	const gamma = Math.sqrt(eta * (2 - eta));
	const decay = 1 - eta;
	const s = new Array(logReturns.length);
	let u = 0;
	s[0] = 0;
	for (let t = 1; t < logReturns.length; t++) {
		u = logReturns[t - 1] + decay * u;
		s[t] = gamma * u;
	}
	return s;
}
/**
* RSI as written by Khaidem, Saha & Dey (arXiv:1605.00003):
*   RSI = 100 - 100 / (1 + RS)
*   RS  = (Average Gain Over past 14 days) / (Average Loss Over past 14 days)
* Simple averages (not Wilder smoothing). Period defaults to 14 as they specify.
* RSI is undefined until `period` closed changes exist; we return NaN then.
*/
function rsiSma(closes, period = 14) {
	const out = new Array(closes.length).fill(NaN);
	if (closes.length < period + 1) return out;
	for (let i = period; i < closes.length; i++) {
		let gain = 0;
		let loss = 0;
		for (let k = i - period + 1; k <= i; k++) {
			const d = closes[k] - closes[k - 1];
			if (d > 0) gain += d;
			else loss -= d;
		}
		const avgGain = gain / period;
		const avgLoss = loss / period;
		if (avgLoss === 0 && avgGain === 0) out[i] = 50;
		else if (avgLoss === 0) out[i] = 100;
		else if (avgGain === 0) out[i] = 0;
		else {
			const rs = avgGain / avgLoss;
			out[i] = 100 - 100 / (1 + rs);
		}
	}
	return out;
}
function rollingStd(xs, window) {
	const out = new Array(xs.length).fill(NaN);
	for (let i = 0; i < xs.length; i++) {
		if (i + 1 < window) continue;
		out[i] = sampleStd(xs.slice(i + 1 - window, i + 1));
	}
	return out;
}
function runningDrawdown(closes) {
	const out = new Array(closes.length);
	let peak = closes[0] ?? 0;
	for (let i = 0; i < closes.length; i++) {
		const c = closes[i];
		if (c > peak) peak = c;
		out[i] = peak === 0 ? 0 : (peak - c) / peak;
	}
	return out;
}
function computeFeatures(candles) {
	const n = candles.length;
	if (n === 0) return [];
	const closes = candles.map((c) => c.close);
	const logReturns = new Array(n);
	logReturns[0] = 0;
	for (let i = 1; i < n; i++) logReturns[i] = logReturn(closes[i - 1], closes[i]);
	const eta = THRESHOLDS.emaEta;
	const emaPrice = recursiveEma(closes, 2 / (THRESHOLDS.priceEmaSpan + 1));
	const emaSignal = grebenkovReturnSignal(logReturns, eta);
	const rsi = rsiSma(closes, THRESHOLDS.rsiPeriod);
	const vol = rollingStd(logReturns, THRESHOLDS.volWindow);
	const dd = runningDrawdown(closes);
	const warmup = Math.max(THRESHOLDS.volWindow, THRESHOLDS.rsiPeriod + 1, THRESHOLDS.priceEmaSpan);
	const out = [];
	for (let i = 0; i < n; i++) {
		const rv = vol[i];
		const ready = i >= warmup && Number.isFinite(rsi[i]) && Number.isFinite(rv);
		const disp = emaPrice[i] === 0 ? 0 : (closes[i] - emaPrice[i]) / emaPrice[i];
		const dispZ = rv > 0 ? disp / rv : 0;
		const z = rv > 0 ? logReturns[i] / rv : 0;
		out.push({
			barIndex: i,
			timestamp: candles[i].t,
			close: closes[i],
			volume: candles[i].volume,
			logReturn: logReturns[i],
			normalizedReturn: ready ? z : NaN,
			emaReturnSignal: emaSignal[i],
			emaPrice: emaPrice[i],
			displacementFromEma: disp,
			displacementZ: ready ? dispZ : NaN,
			rsi14: rsi[i],
			realizedVol: rv,
			drawdown: dd[i],
			warmupComplete: ready
		});
	}
	return out;
}
var JEV_MODEL_MOCK = "mock-jev-not-typesafe";
/**
* Atomic questions asked independently of each other.
* Jev is never asked to emit BUY/SELL prose.
*
* Official clients (Sprint 0 not called):
*   Python: typesafe_sdk.TypeSafeClient().system_one(state, questions)
*           with Choice / Noul / Score
*   JS:     @typesafe-ai/sdk TypeSafeClient.systemOne({ state, questions })
*           with choice() / noul() / score()
* HTTP:     POST https://api.typesafe.ai/v1/systemone
*/
var JEV_QUESTIONS = {
	REGIME: {
		type: "choice",
		instructions: "Classify the current market regime from the supplied quantitative state only. Do not recommend a trade. trend_up: persistent positive ema_return_signal with displacement_from_ema aligned positive. trend_down: persistent negative ema_return_signal with displacement aligned negative. mean_reverting: large |displacement_z| and RSI away from 50 that is more consistent with a snap-back than with continuation. ambiguous: mixed or insufficient evidence.",
		criteria: {
			trend_up: "Directional upward environment: ema_return_signal > 0 and price not stretched against the signal.",
			trend_down: "Directional downward environment: ema_return_signal < 0 and price not stretched against the signal.",
			mean_reverting: "Mean-reversion environment: displacement from the local EMA is large relative to realized_vol.",
			ambiguous: "No option is clearly supported by the supplied numbers."
		}
	},
	LONG_SETUP: {
		type: "noul",
		instructions: "Does the supplied quantitative state support the predefined long setup? Predefined long setup: (directional) ema_return_signal is positive and displacement_from_ema is not deeply negative, OR (mean-reversion) rsi_14 is below 30 and displacement_from_ema is negative. Answer from the numbers only. Do not output a trade instruction."
	},
	SHORT_SETUP: {
		type: "noul",
		instructions: "Does the supplied quantitative state support the predefined short setup? Predefined short setup: (directional) ema_return_signal is negative and displacement_from_ema is not deeply positive, OR (mean-reversion) rsi_14 is above 70 and displacement_from_ema is positive. Answer from the numbers only. Do not output a trade instruction."
	},
	MEAN_REVERSION: {
		type: "noul",
		instructions: "Does the supplied state exhibit the predefined characteristics of a mean-reversion environment: elevated |displacement_z|, RSI away from 50, and a modest |ema_return_signal|? Do not output a trade instruction."
	},
	TREND: {
		type: "noul",
		instructions: "Does the supplied state exhibit the predefined characteristics of a directional trend environment: |ema_return_signal| large relative to typical scale, with displacement_from_ema aligned to the signal? Do not output a trade instruction."
	},
	MARKET_QUALITY: {
		type: "score",
		instructions: "Score the usability of this state for a predefined quantitative setup. hostile: extreme realized_vol or deep drawdown. weak: noisy, mixed features. usable: features defined, vol not extreme. strong: features aligned and vol moderate. This is not a forecast of P&L.",
		criteria: [
			"hostile",
			"weak",
			"usable",
			"strong"
		]
	}
};
function featuresToJevState(f) {
	const num = (x) => Number.isFinite(x) ? Number(x.toFixed(8)) : null;
	return {
		symbol: SYMBOL,
		timeframe: "1D",
		close: Number(f.close.toFixed(6)),
		log_return: num(f.logReturn) ?? 0,
		normalized_return: num(f.normalizedReturn) ?? 0,
		ema_return_signal: num(f.emaReturnSignal) ?? 0,
		ema_price: Number(f.emaPrice.toFixed(6)),
		displacement_from_ema: num(f.displacementFromEma) ?? 0,
		displacement_z: num(f.displacementZ) ?? 0,
		rsi_14: Number.isFinite(f.rsi14) ? Number(f.rsi14.toFixed(4)) : 50,
		realized_vol: Number.isFinite(f.realizedVol) ? Number(f.realizedVol.toFixed(8)) : 0,
		drawdown: Number(f.drawdown.toFixed(6)),
		volume: f.volume
	};
}
function buildJevRequest(f, model) {
	return {
		model,
		state: featuresToJevState(f),
		questions: JEV_QUESTIONS
	};
}
function softmax(logits) {
	const keys = Object.keys(logits);
	const max = Math.max(...keys.map((k) => logits[k]));
	const exps = {};
	let z = 0;
	for (const k of keys) {
		const e = Math.exp(logits[k] - max);
		exps[k] = e;
		z += e;
	}
	const out = {};
	for (const k of keys) out[k] = exps[k] / z;
	return out;
}
function sigmoid(x) {
	if (x > 20) return 1;
	if (x < -20) return 0;
	return 1 / (1 + Math.exp(-x));
}
function argmax(probs) {
	let best = "";
	let v = -Infinity;
	for (const [k, p] of Object.entries(probs)) if (p > v) {
		v = p;
		best = k;
	}
	return best;
}
var QUALITY = [
	"hostile",
	"weak",
	"usable",
	"strong"
];
/**
* Deterministic stand-in. Same features ⇒ same typed answers.
* Not Jev. Arm D on this adapter is not a TypeSafe evaluation.
*/
function mockClassify(features) {
	const s = features.emaReturnSignal;
	const z = Number.isFinite(features.displacementZ) ? features.displacementZ : 0;
	const rsi = Number.isFinite(features.rsi14) ? features.rsi14 : 50;
	const rv = Number.isFinite(features.realizedVol) ? features.realizedVol : 0;
	const dd = features.drawdown;
	const sZ = rv > 0 ? s / rv : s * 80;
	const regimeP = softmax({
		trend_up: 1.1 * sZ + .25 * z,
		trend_down: -1.1 * sZ - .25 * z,
		mean_reverting: .45 * Math.abs(z) + .03 * Math.abs(rsi - 50) - .9 * Math.abs(sZ),
		ambiguous: .7 - .55 * Math.abs(sZ) - .2 * Math.abs(z)
	});
	const regimeChoice = argmax(regimeP);
	const regimeConf = Math.min(.99, Math.max(.05, (regimeP[regimeChoice] - 1 / 4) / (1 - 1 / 4)));
	const longTrend = 1.15 * sZ - .25 * Math.max(0, -z);
	const longMr = .14 * (THRESHOLDS.rsiOversold - rsi) + .35 * Math.max(0, -z);
	const longNoul = sigmoid(Math.max(longTrend, longMr));
	const shortTrend = -1.15 * sZ - .25 * Math.max(0, z);
	const shortMr = .14 * (rsi - THRESHOLDS.rsiOverbought) + .35 * Math.max(0, z);
	const shortNoul = sigmoid(Math.max(shortTrend, shortMr));
	const mrNoul = sigmoid(.55 * Math.abs(z) + .04 * Math.abs(rsi - 50) - .7 * Math.abs(sZ) - .15);
	const trendNoul = sigmoid(.95 * Math.abs(sZ) + .2 * Math.sign(sZ) * z - .15);
	let qLogit = 1.2 - 40 * Math.max(0, rv - .02) - 4 * dd;
	if (!features.warmupComplete) qLogit = -2;
	const qP = softmax({
		hostile: -qLogit + 1.4 * Math.max(0, rv - .03) * 40 + 3 * Math.max(0, dd - .1),
		weak: .6 - .4 * qLogit,
		usable: qLogit,
		strong: qLogit - .8 + (Math.abs(s) > .2 ? .4 : 0)
	});
	const qLevel = argmax(qP);
	const qScore = QUALITY.indexOf(qLevel);
	const qConf = Math.min(.99, Math.max(.05, (qP[qLevel] - .25) / .75));
	return {
		model: JEV_MODEL_MOCK,
		requestId: `mock-${features.barIndex}-${Math.round(features.close * 1e4)}`,
		latencyMs: 4 + features.barIndex % 9,
		answers: {
			REGIME: {
				type: "choice",
				choice: regimeChoice,
				probabilities: regimeP,
				confidence: Number(regimeConf.toFixed(4))
			},
			LONG_SETUP: {
				type: "noul",
				noul: Number(longNoul.toFixed(4))
			},
			SHORT_SETUP: {
				type: "noul",
				noul: Number(shortNoul.toFixed(4))
			},
			MEAN_REVERSION: {
				type: "noul",
				noul: Number(mrNoul.toFixed(4))
			},
			TREND: {
				type: "noul",
				noul: Number(trendNoul.toFixed(4))
			},
			MARKET_QUALITY: {
				type: "score",
				score: qScore,
				probabilities: qP,
				confidence: Number(qConf.toFixed(4)),
				level: qLevel
			}
		}
	};
}
function createMockJevAdapter() {
	return {
		id: "mock",
		model: JEV_MODEL_MOCK,
		classify: (features) => mockClassify(features)
	};
}
var QUALITY_RANK = {
	hostile: 0,
	weak: 1,
	usable: 2,
	strong: 3
};
function classifyDeterministicRegime(f) {
	if (!f.warmupComplete) return "ambiguous";
	const s = f.emaReturnSignal;
	const z = f.displacementZ;
	const rsi = f.rsi14;
	const trendish = (f.realizedVol > 0 ? Math.abs(s) / f.realizedVol : 0) >= THRESHOLDS.emaSignalEnterZ;
	const stretched = Math.abs(z) >= 1.2 || rsi <= THRESHOLDS.rsiOversold || rsi >= THRESHOLDS.rsiOverbought;
	if (trendish && s > 0 && z >= 0) return "trend_up";
	if (trendish && s < 0 && z <= 0) return "trend_down";
	if (!trendish && stretched) return "mean_reverting";
	return "ambiguous";
}
function emaTrendSignal(f) {
	const reasonBase = "Grebenkov-style s_t vs UNCALIBRATED |s|/vol floor. Linear paper positions were not thresholded; discretization is ours.";
	if (!f.warmupComplete) return {
		strategyId: "ema_trend",
		strategyVersion: STRATEGY_VERSION,
		desired: "FLAT",
		reason: "Warmup incomplete."
	};
	const z = f.realizedVol > 0 ? f.emaReturnSignal / f.realizedVol : 0;
	if (z > THRESHOLDS.emaSignalEnterZ) return {
		strategyId: "ema_trend",
		strategyVersion: STRATEGY_VERSION,
		desired: "LONG",
		reason: `${reasonBase} s/vol=${z.toFixed(2)} > ${THRESHOLDS.emaSignalEnterZ}.`
	};
	if (z < -THRESHOLDS.emaSignalEnterZ) return {
		strategyId: "ema_trend",
		strategyVersion: STRATEGY_VERSION,
		desired: "SHORT",
		reason: `${reasonBase} s/vol=${z.toFixed(2)} < -${THRESHOLDS.emaSignalEnterZ}.`
	};
	return {
		strategyId: "ema_trend",
		strategyVersion: STRATEGY_VERSION,
		desired: "FLAT",
		reason: `${reasonBase} |s|/vol below enter.`
	};
}
function rsiMeanReversionSignal(f) {
	const reasonBase = "RSI(14) SMA as in Khaidem et al. Oversold/overbought bands are conventional UNCALIBRATED gates, not a paper trading rule.";
	if (!f.warmupComplete) return {
		strategyId: "rsi_mean_reversion",
		strategyVersion: STRATEGY_VERSION,
		desired: "FLAT",
		reason: "Warmup incomplete."
	};
	if (f.rsi14 <= THRESHOLDS.rsiOversold) return {
		strategyId: "rsi_mean_reversion",
		strategyVersion: STRATEGY_VERSION,
		desired: "LONG",
		reason: `${reasonBase} RSI=${f.rsi14.toFixed(2)} ≤ ${THRESHOLDS.rsiOversold}.`
	};
	if (f.rsi14 >= THRESHOLDS.rsiOverbought) return {
		strategyId: "rsi_mean_reversion",
		strategyVersion: STRATEGY_VERSION,
		desired: "SHORT",
		reason: `${reasonBase} RSI=${f.rsi14.toFixed(2)} ≥ ${THRESHOLDS.rsiOverbought}.`
	};
	return {
		strategyId: "rsi_mean_reversion",
		strategyVersion: STRATEGY_VERSION,
		desired: "FLAT",
		reason: `${reasonBase} RSI inside bands.`
	};
}
function evaluateSignal(id, f) {
	return id === "ema_trend" ? emaTrendSignal(f) : rsiMeanReversionSignal(f);
}
function regimeAligned(strategyId, desired, regime) {
	if (desired === "FLAT") return true;
	if (strategyId === "ema_trend") {
		if (desired === "LONG") return regime === "trend_up";
		return regime === "trend_down";
	}
	return regime === "mean_reverting";
}
function jevAllows(strategyId, desired, jev) {
	const a = jev.answers;
	const qualityOk = QUALITY_RANK[a.MARKET_QUALITY.level] >= QUALITY_RANK[THRESHOLDS.minQuality];
	const regime = a.REGIME.choice;
	const regimeOk = a.REGIME.confidence >= THRESHOLDS.regimeConfidence;
	if (!qualityOk) return {
		pass: false,
		reason: `Jev MARKET_QUALITY=${a.MARKET_QUALITY.level} below UNCALIBRATED ${THRESHOLDS.minQuality}.`
	};
	if (desired === "FLAT") return {
		pass: true,
		reason: "No entry requested."
	};
	if (desired === "LONG" && a.LONG_SETUP.noul < THRESHOLDS.longSetupNoul) return {
		pass: false,
		reason: `LONG_SETUP noul ${a.LONG_SETUP.noul.toFixed(2)} < ${THRESHOLDS.longSetupNoul} UNCALIBRATED.`
	};
	if (desired === "SHORT" && a.SHORT_SETUP.noul < THRESHOLDS.shortSetupNoul) return {
		pass: false,
		reason: `SHORT_SETUP noul ${a.SHORT_SETUP.noul.toFixed(2)} < ${THRESHOLDS.shortSetupNoul} UNCALIBRATED.`
	};
	if (strategyId === "ema_trend") {
		if (a.TREND.noul < THRESHOLDS.trendNoul) return {
			pass: false,
			reason: `TREND noul ${a.TREND.noul.toFixed(2)} < ${THRESHOLDS.trendNoul} UNCALIBRATED.`
		};
		if (regimeOk) {
			if (desired === "LONG" && regime !== "trend_up") return {
				pass: false,
				reason: `Jev REGIME=${regime}, not trend_up.`
			};
			if (desired === "SHORT" && regime !== "trend_down") return {
				pass: false,
				reason: `Jev REGIME=${regime}, not trend_down.`
			};
		}
	} else {
		if (a.MEAN_REVERSION.noul < THRESHOLDS.meanReversionNoul) return {
			pass: false,
			reason: `MEAN_REVERSION noul ${a.MEAN_REVERSION.noul.toFixed(2)} < ${THRESHOLDS.meanReversionNoul} UNCALIBRATED.`
		};
		if (regimeOk && regime !== "mean_reverting") return {
			pass: false,
			reason: `Jev REGIME=${regime}, not mean_reverting.`
		};
	}
	return {
		pass: true,
		reason: "Jev gates passed (UNCALIBRATED thresholds)."
	};
}
function evaluatePolicy(input) {
	const { arm, strategyId, signal, detRegime, jev } = input;
	const a = jev.answers;
	let desired = "FLAT";
	let reason = "";
	if (arm === "A") {
		desired = "LONG";
		reason = "Arm A baseline: unit long buy-and-hold.";
	} else if (arm === "B") {
		desired = signal.desired;
		reason = `Arm B: ${signal.reason}`;
	} else if (arm === "C") {
		if (signal.desired === "FLAT") {
			desired = "FLAT";
			reason = `Arm C: ${signal.reason}`;
		} else if (regimeAligned(strategyId, signal.desired, detRegime)) {
			desired = signal.desired;
			reason = `Arm C: signal ${signal.desired} aligned with det. regime ${detRegime}.`;
		} else {
			desired = "FLAT";
			reason = `Arm C: det. regime ${detRegime} rejected ${signal.desired}.`;
		}
	} else {
		const gate = jevAllows(strategyId, signal.desired, jev);
		desired = gate.pass ? signal.desired : "FLAT";
		reason = `Arm D: ${gate.reason}`;
	}
	return {
		version: POLICY_VERSION,
		arm,
		deterministicSignal: signal.desired,
		deterministicRegime: detRegime,
		jevRegime: a.REGIME.choice,
		jevLongPass: a.LONG_SETUP.noul >= THRESHOLDS.longSetupNoul,
		jevShortPass: a.SHORT_SETUP.noul >= THRESHOLDS.shortSetupNoul,
		jevTrendPass: a.TREND.noul >= THRESHOLDS.trendNoul,
		jevMeanReversionPass: a.MEAN_REVERSION.noul >= THRESHOLDS.meanReversionNoul,
		jevQualityPass: QUALITY_RANK[a.MARKET_QUALITY.level] >= QUALITY_RANK[THRESHOLDS.minQuality],
		desired,
		reason
	};
}
function evaluateRisk(input) {
	const reasons = [];
	const { desired, features, equityDrawdown } = input;
	let target = desired;
	if (!features.warmupComplete) {
		target = "FLAT";
		reasons.push("Warmup incomplete.");
	}
	if (Number.isFinite(features.realizedVol) && features.realizedVol > THRESHOLDS.maxRealizedVol && desired !== "FLAT") {
		target = "FLAT";
		reasons.push(`realized_vol ${features.realizedVol.toFixed(4)} > UNCALIBRATED ${THRESHOLDS.maxRealizedVol}.`);
	}
	if (features.drawdown > THRESHOLDS.maxDrawdown && desired !== "FLAT") {
		target = "FLAT";
		reasons.push(`price drawdown ${features.drawdown.toFixed(3)} > UNCALIBRATED ${THRESHOLDS.maxDrawdown}.`);
	}
	if (equityDrawdown > THRESHOLDS.maxDrawdown && desired !== "FLAT") {
		target = "FLAT";
		reasons.push(`paper equity drawdown ${equityDrawdown.toFixed(3)} > UNCALIBRATED ${THRESHOLDS.maxDrawdown}.`);
	}
	if (reasons.length === 0) reasons.push("Risk checks passed (UNCALIBRATED).");
	return {
		version: RISK_VERSION,
		pass: target === desired,
		target,
		reasons,
		maxPosition: 1,
		realizedVol: features.realizedVol,
		drawdown: features.drawdown
	};
}
function actionToPosition(action) {
	if (action === "LONG") return 1;
	if (action === "SHORT") return -1;
	return 0;
}
function positionOf(action) {
	if (action === "LONG") return 1;
	if (action === "SHORT") return -1;
	return 0;
}
function computePathMetrics(candles, evidences) {
	const byBar = /* @__PURE__ */ new Map();
	for (const e of evidences) byBar.set(e.barIndex, e);
	const rets = [];
	let equity = 1;
	let peak = 1;
	let maxDd = 0;
	let turnover = 0;
	let exposure = 0;
	let prevPos = 0;
	let tradeCount = 0;
	let wins = 0;
	let rounds = 0;
	let roundPnl = 0;
	let inTrade = "FLAT";
	const cost = THRESHOLDS.transactionCostBps / 1e4;
	for (let i = 1; i < candles.length; i++) {
		const prev = candles[i - 1];
		const r = Math.log(candles[i].close / prev.close);
		const ev = byBar.get(i - 1);
		const pos = ev ? positionOf(ev.action) : 0;
		const delta = Math.abs(pos - prevPos);
		turnover += delta;
		if (delta > 0) {
			if (inTrade !== "FLAT") {
				rounds += 1;
				if (roundPnl > 0) wins += 1;
				roundPnl = 0;
			}
			inTrade = ev?.action ?? "FLAT";
			tradeCount += 1;
		}
		const net = pos * r - cost * delta;
		equity *= Math.exp(net);
		roundPnl += net;
		rets.push(net);
		exposure += Math.abs(pos);
		if (equity > peak) peak = equity;
		maxDd = Math.max(maxDd, peak === 0 ? 0 : (peak - equity) / peak);
		prevPos = pos;
	}
	const mu = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
	const sd = sampleStd(rets);
	const down = sampleStd(rets.filter((x) => x < 0));
	const ann = Math.sqrt(252);
	const sharpe = sd > 0 ? mu / sd * ann : null;
	const sortino = down > 0 ? mu / down * ann : null;
	const T = Math.max(1, candles.length - 1);
	return {
		barCount: candles.length,
		tradeCount,
		hitRate: rounds > 0 ? wins / rounds : null,
		totalReturn: equity - 1,
		sharpe,
		sortino,
		maxDrawdown: maxDd,
		turnover: turnover / T,
		exposure: exposure / T,
		transactionCostBps: THRESHOLDS.transactionCostBps,
		slippageBps: THRESHOLDS.slippageBps,
		abstainedCount: evidences.filter((e) => e.abstained).length,
		note: "In-sample on synthetic seeded candles. Not walk-forward. Not a performance claim. Costs 0 bps UNCALIBRATED."
	};
}
function oneHot(choice, keys) {
	const o = {};
	for (const k of keys) o[k] = k === choice ? 1 : 0;
	return o;
}
function outcomeRegime(candles, i, horizon) {
	if (i + horizon >= candles.length) return "ambiguous";
	const p0 = candles[i].close;
	const p1 = candles[i + horizon].close;
	const r = Math.log(p1 / p0);
	if (r > .015) return "trend_up";
	if (r < -.015) return "trend_down";
	const mid = candles[i + Math.floor(horizon / 2)].close;
	const d0 = Math.abs(Math.log(p0 / mid));
	if (Math.abs(Math.log(p1 / mid)) < d0 * .7) return "mean_reverting";
	return "ambiguous";
}
function computeJevMetrics(candles, evidences) {
	const keys = [
		"trend_up",
		"trend_down",
		"mean_reverting",
		"ambiguous"
	];
	let brierSum = 0;
	let brierN = 0;
	const buckets = [
		{
			lo: 0,
			hi: .25,
			n: 0,
			hit: 0,
			pSum: 0,
			ySum: 0
		},
		{
			lo: .25,
			hi: .5,
			n: 0,
			hit: 0,
			pSum: 0,
			ySum: 0
		},
		{
			lo: .5,
			hi: .75,
			n: 0,
			hit: 0,
			pSum: 0,
			ySum: 0
		},
		{
			lo: .75,
			hi: 1.01,
			n: 0,
			hit: 0,
			pSum: 0,
			ySum: 0
		}
	];
	const confBuckets = [
		{
			lo: 0,
			hi: .33,
			n: 0,
			hit: 0
		},
		{
			lo: .33,
			hi: .66,
			n: 0,
			hit: 0
		},
		{
			lo: .66,
			hi: 1.01,
			n: 0,
			hit: 0
		}
	];
	const byRegime = {};
	for (const k of keys) byRegime[k] = {
		n: 0,
		sum: 0
	};
	for (const e of evidences) {
		if (!e.features.warmupComplete) continue;
		const y = outcomeRegime(candles, e.barIndex, THRESHOLDS.regimeOutcomeHorizon);
		const p = e.jevResponse.answers.REGIME.probabilities;
		const yoh = oneHot(y, keys);
		let b = 0;
		for (const k of keys) {
			const pk = p[k] ?? 0;
			b += (pk - (yoh[k] ?? 0)) ** 2;
		}
		brierSum += b;
		brierN += 1;
		const pChosen = p[e.jevResponse.answers.REGIME.choice] ?? 0;
		const hit = e.jevResponse.answers.REGIME.choice === y ? 1 : 0;
		for (const bucket of buckets) if (pChosen >= bucket.lo && pChosen < bucket.hi) {
			bucket.n += 1;
			bucket.hit += hit;
			bucket.pSum += pChosen;
			bucket.ySum += hit;
		}
		const c = e.jevResponse.answers.REGIME.confidence;
		for (const bucket of confBuckets) if (c >= bucket.lo && c < bucket.hi) {
			bucket.n += 1;
			bucket.hit += hit;
		}
		const nxt = e.barIndex + 1 < candles.length ? Math.log(candles[e.barIndex + 1].close / candles[e.barIndex].close) : 0;
		const signed = positionOf(e.action) * nxt;
		const slot = byRegime[e.jevResponse.answers.REGIME.choice];
		if (slot) {
			slot.n += 1;
			slot.sum += signed;
		}
	}
	const calibrationBuckets = buckets.map((b) => ({
		p: b.n ? b.pSum / b.n : 0,
		freq: b.n ? b.ySum / b.n : 0,
		n: b.n
	}));
	const selectiveAccuracy = [
		.5,
		.7,
		.9
	].map((coverage) => {
		const ranked = evidences.filter((e) => e.features.warmupComplete).slice().sort((a, b) => b.jevResponse.answers.REGIME.confidence - a.jevResponse.answers.REGIME.confidence);
		const take = Math.max(1, Math.floor(ranked.length * coverage));
		const slice = ranked.slice(0, take);
		let hit = 0;
		for (const e of slice) {
			const y = outcomeRegime(candles, e.barIndex, THRESHOLDS.regimeOutcomeHorizon);
			if (e.jevResponse.answers.REGIME.choice === y) hit += 1;
		}
		return {
			coverage,
			accuracy: slice.length ? hit / slice.length : 0
		};
	});
	return {
		brierRegime: brierN ? brierSum / brierN : null,
		calibrationBuckets,
		confidenceBuckets: confBuckets.map((b) => ({
			lo: b.lo,
			hi: b.hi,
			n: b.n,
			hit: b.n ? b.hit / b.n : 0
		})),
		selectiveAccuracy,
		decisionsAbstained: evidences.filter((e) => e.abstained).length,
		byRegime: Object.fromEntries(Object.entries(byRegime).map(([k, v]) => [k, {
			n: v.n,
			meanReturn: v.n ? v.sum / v.n : 0
		}])),
		note: "Jev metrics vs our proxy regime outcome (next-5-bar return/displacement). Mock adapter, not TypeSafe Jev. Not a calibration of the live model."
	};
}
function assertPaperOnly(mode) {
	if (mode !== "PAPER_REPLAY") throw new Error("LIVE_TRADING_FORBIDDEN");
}
var RESEARCH_FOR = {
	ema_trend: ["arXiv:1308.5658", "arXiv:2602.10785"],
	rsi_mean_reversion: [
		"arXiv:1605.00003",
		"arXiv:1408.2217",
		"arXiv:2412.15448"
	]
};
function runSession(input) {
	assertPaperOnly(TRADING_MODE);
	const candles = input.candles ?? generateSyntheticCandles();
	const adapter = input.adapter ?? createMockJevAdapter();
	const features = computeFeatures(candles);
	const evidences = [];
	const fills = [];
	let position = 0;
	let equity = 1;
	let peak = 1;
	for (let i = 0; i < candles.length; i++) {
		const f = features[i];
		const signal = evaluateSignal(input.strategyId, f);
		const detRegime = classifyDeterministicRegime(f);
		const jevRequest = buildJevRequest(f, adapter.model);
		const jevResponse = adapter.classify(f);
		const policy = evaluatePolicy({
			arm: input.arm,
			strategyId: input.strategyId,
			signal,
			detRegime,
			jev: jevResponse
		});
		const equityDd = peak === 0 ? 0 : Math.max(0, (peak - equity) / peak);
		const risk = evaluateRisk({
			desired: policy.desired,
			features: f,
			equityDrawdown: equityDd
		});
		const action = risk.target;
		const pos = actionToPosition(action);
		const abstained = policy.desired !== action || action === "FLAT" && signal.desired !== "FLAT";
		const id = `LL-${SYMBOL}-1D-${String(i).padStart(4, "0")}`;
		const ev = {
			id,
			timestamp: f.timestamp,
			barIndex: i,
			symbol: SYMBOL,
			timeframe: "1D",
			tradingMode: TRADING_MODE,
			marketSnapshot: candles[i],
			features: f,
			strategyId: input.strategyId,
			strategyVersion: STRATEGY_VERSION,
			researchRefs: RESEARCH_FOR[input.strategyId],
			deterministicSignal: signal,
			deterministicRegime: detRegime,
			jevRequest,
			jevResponse,
			policy,
			risk,
			action,
			positionAfter: pos,
			abstained
		};
		evidences.push(ev);
		if (pos !== position && i + 1 < candles.length) fills.push({
			decisionId: id,
			barIndex: i,
			fillBarIndex: i + 1,
			action,
			positionAfter: pos,
			fillPrice: candles[i + 1].close,
			note: "UNCALIBRATED next-bar close fill. Paper only."
		});
		if (i + 1 < candles.length) {
			const r = Math.log(candles[i + 1].close / candles[i].close);
			equity *= Math.exp(position * r);
			if (equity > peak) peak = equity;
		}
		position = pos;
	}
	return {
		arm: input.arm,
		strategyId: input.strategyId,
		candles,
		evidences,
		fills,
		metrics: computePathMetrics(candles, evidences),
		jevMetrics: computeJevMetrics(candles, evidences)
	};
}
function runAllArms(strategyId, candles) {
	const series = candles ?? generateSyntheticCandles();
	const adapter = createMockJevAdapter();
	return Object.fromEntries([
		"A",
		"B",
		"C",
		"D"
	].map((arm) => [arm, runSession({
		arm,
		strategyId,
		candles: series,
		adapter
	})]));
}
var candles = generateSyntheticCandles();
function sessionsFor(strategyId) {
	return runAllArms(strategyId, candles);
}
function lastWarm(session) {
	const i = session.evidences.findIndex((e) => e.features.warmupComplete);
	return i < 0 ? 40 : i;
}
var initialSessions = sessionsFor("ema_trend");
var useTerminal = create((set, get) => ({
	strategyId: "ema_trend",
	arm: "D",
	cursor: lastWarm(initialSessions.D),
	playing: false,
	helpOpen: false,
	evidenceOpen: false,
	selectedId: null,
	mobileTab: "chart",
	sessions: initialSessions,
	setStrategy: (id) => {
		const sessions = sessionsFor(id);
		const arm = get().arm;
		set({
			strategyId: id,
			sessions,
			cursor: Math.min(get().cursor, sessions[arm].candles.length - 1)
		});
	},
	setArm: (arm) => set({ arm }),
	setCursor: (i) => {
		const n = get().sessions[get().arm].candles.length;
		set({ cursor: Math.max(0, Math.min(n - 1, i)) });
	},
	step: (delta) => {
		const n = get().sessions[get().arm].candles.length;
		set({ cursor: Math.max(0, Math.min(n - 1, get().cursor + delta)) });
	},
	togglePlay: () => set({ playing: !get().playing }),
	setPlaying: (v) => set({ playing: v }),
	toggleHelp: () => set({ helpOpen: !get().helpOpen }),
	openEvidence: (id) => {
		const fallback = get().sessions[get().arm].evidences[get().cursor]?.id ?? null;
		set({
			evidenceOpen: true,
			selectedId: id ?? fallback
		});
	},
	closeEvidence: () => set({ evidenceOpen: false }),
	setMobileTab: (tab) => set({ mobileTab: tab })
}));
function selectSession(s) {
	return s.sessions[s.arm];
}
function selectEvidence(s) {
	return s.sessions[s.arm].evidences[s.cursor];
}
function selectById(s, id) {
	if (!id) return void 0;
	return s.sessions[s.arm].evidences.find((e) => e.id === id);
}
function cn(...inputs) {
	return twMerge(clsx(inputs));
}
function Panel({ title, meta, children, className }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
		className: cn("flex min-h-0 min-w-0 flex-col overflow-hidden border-line bg-surface", className),
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
			className: "flex h-7 shrink-0 items-center justify-between gap-2 border-b border-line px-2",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
				className: "kicker",
				children: title
			}), meta ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: "truncate font-mono text-2xs text-subtle",
				children: meta
			}) : null]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "min-h-0 flex-1 overflow-auto p-2",
			children
		})]
	});
}
function Kv({ k, v, tone }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-baseline justify-between gap-3",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
			className: "font-mono text-2xs uppercase tracking-wider text-subtle",
			children: k
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
			className: cn("tabular font-mono text-sm", tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : "text-fg"),
			children: v
		})]
	});
}
function DecisionTrace() {
	const ev = useTerminal(selectEvidence);
	const openEvidence = useTerminal((s) => s.openEvidence);
	const steps = ev ? [
		{
			k: "candle closed",
			v: ev.id
		},
		{
			k: "features computed",
			v: `s_t ${ev.features.emaReturnSignal.toFixed(3)} · RSI ${Number.isFinite(ev.features.rsi14) ? ev.features.rsi14.toFixed(1) : "—"}`
		},
		{
			k: "deterministic signal",
			v: ev.deterministicSignal.desired
		},
		{
			k: "Jev request",
			v: ev.jevRequest.model
		},
		{
			k: "Jev response",
			v: `${ev.jevResponse.answers.REGIME.choice} · L ${ev.jevResponse.answers.LONG_SETUP.noul.toFixed(2)} S ${ev.jevResponse.answers.SHORT_SETUP.noul.toFixed(2)}`
		},
		{
			k: "policy evaluation",
			v: ev.policy.desired
		},
		{
			k: "risk evaluation",
			v: ev.risk.target
		},
		{
			k: "action / abstention",
			v: ev.abstained && ev.action === "FLAT" ? "ABSTAIN → FLAT" : ev.action
		}
	] : [];
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Panel, {
		title: "Decision trace",
		meta: ev?.id,
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", {
			className: "flex flex-col",
			children: steps.map((s, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
				className: "grid grid-cols-[16px_1fr] gap-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
					className: "flex flex-col items-center",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: cn("mt-1 size-1.5 rounded-full", i === steps.length - 1 ? "bg-fg" : "bg-muted") }), i < steps.length - 1 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "w-px flex-1 bg-line" }) : null]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: cn("pb-2", i === steps.length - 1 && "pb-0"),
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "font-mono text-2xs uppercase tracking-wider text-subtle",
						children: s.k
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "truncate font-mono text-xs text-fg",
						children: s.v
					})]
				})]
			}, s.k))
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
			type: "button",
			onClick: () => openEvidence(),
			className: "mt-3 h-8 w-full rounded-sm bg-elevated font-mono text-2xs text-fg ring-1 ring-line-strong hover:bg-bg",
			children: "Inspect evidence"
		})]
	});
}
function fmtNum(x, digits = 2) {
	if (x === null || x === void 0 || !Number.isFinite(x)) return "—";
	return x.toLocaleString("en-US", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	});
}
function fmtPct(x, digits = 2) {
	if (x === null || x === void 0 || !Number.isFinite(x)) return "—";
	const n = x * 100;
	return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}
function fmtPx(x) {
	if (x === null || x === void 0 || !Number.isFinite(x)) return "—";
	return x.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	});
}
function fmtUtc(ms) {
	return new Date(ms).toISOString().replace(".000Z", "Z");
}
function fmtUtcShort(ms) {
	return new Date(ms).toISOString().slice(0, 10);
}
function signedClass(x) {
	if (!Number.isFinite(x) || x === 0) return "text-muted";
	return x > 0 ? "text-up" : "text-down";
}
function EvalStrip() {
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
		["Brier", fmtNum(j.brierRegime, 3)]
	];
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex shrink-0 gap-px overflow-x-auto border-t border-line bg-elevated",
		children: [cells.map(([k, v]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex min-w-[4.5rem] flex-col px-2 py-1.5",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: "font-mono text-2xs uppercase tracking-wider text-subtle",
				children: k
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: "tabular font-mono text-xs text-fg",
				children: v
			})]
		}, k)), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
			className: "hidden min-w-[16rem] flex-1 px-3 py-1.5 font-mono text-2xs leading-snug text-warn lg:block",
			children: m.note
		})]
	});
}
function EvidenceDrawer() {
	const open = useTerminal((s) => s.evidenceOpen);
	const close = useTerminal((s) => s.closeEvidence);
	const selectedId = useTerminal((s) => s.selectedId);
	const ev = useTerminal((s) => selectById(s, s.selectedId));
	if (!open) return null;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "fixed inset-0 z-40 flex items-end justify-end bg-bg/70 md:items-stretch",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
			type: "button",
			className: "absolute inset-0 cursor-default",
			"aria-label": "Close evidence",
			onClick: close
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
			className: "relative z-10 flex h-5/6 w-full max-w-xl flex-col border-l border-line bg-elevated shadow-[0_0_0_1px_rgba(255,255,255,0.08)] md:h-full",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
				className: "flex h-10 shrink-0 items-center justify-between border-b border-line px-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "kicker",
					children: "Evidence"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "font-mono text-xs text-fg",
					children: selectedId
				})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: close,
					className: "grid size-8 place-items-center rounded-sm text-muted hover:bg-surface hover:text-fg",
					children: "Esc"
				})]
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "min-h-0 flex-1 overflow-auto p-3",
				children: ev ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-2",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
						className: "font-mono text-2xs text-subtle",
						children: [
							fmtUtc(ev.timestamp),
							" · ",
							ev.symbol,
							" ",
							ev.timeframe,
							" · ",
							ev.tradingMode
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
						className: "overflow-x-auto rounded-sm bg-bg p-3 font-mono text-2xs leading-snug text-muted",
						children: JSON.stringify({
							id: ev.id,
							timestamp: ev.timestamp,
							symbol: ev.symbol,
							timeframe: ev.timeframe,
							marketSnapshot: ev.marketSnapshot,
							featureValues: ev.features,
							strategy: {
								id: ev.strategyId,
								version: ev.strategyVersion
							},
							jevRequest: ev.jevRequest,
							jevResponse: ev.jevResponse,
							policy: ev.policy,
							risk: ev.risk,
							resultingAction: ev.action,
							researchReferences: ev.researchRefs
						}, null, 2)
					})]
				}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-muted",
					children: "No evidence object for this cursor."
				})
			})]
		})]
	});
}
function Distro({ probs, chosen }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
		className: "flex flex-col gap-1",
		children: Object.entries(probs).map(([k, p]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
			className: "flex items-center gap-1",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					className: cn("w-24 truncate font-mono text-2xs", k === chosen ? "text-fg" : "text-muted"),
					children: k
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					className: "h-1.5 min-w-0 flex-1 overflow-hidden rounded-xs bg-elevated",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "block h-full bg-accent",
						style: { width: `${Math.max(0, Math.min(100, p * 100))}%` }
					})
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					className: "tabular w-9 text-right font-mono text-2xs text-muted",
					children: fmtNum(p, 2)
				})
			]
		}, k))
	});
}
function NoulRow({ label, p, pass }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-center gap-1",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: "min-w-0 flex-1 font-mono text-2xs text-muted",
				children: label
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: "tabular w-11 text-right font-mono text-xs text-fg",
				children: fmtNum(p, 2)
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: cn("w-12 text-right font-mono text-2xs", pass ? "text-up" : "text-subtle"),
				children: pass ? "pass" : "hold"
			})
		]
	});
}
function JevPanel() {
	const ev = useTerminal(selectEvidence);
	const a = ev?.jevResponse.answers;
	if (!a || !ev) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Panel, {
		title: "Jev",
		meta: "no bar",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
			className: "text-xs text-muted",
			children: "No closed candle yet."
		})
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Panel, {
		title: "Jev",
		meta: `${ev.jevResponse.model} · ${ev.jevResponse.latencyMs} ms`,
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col gap-3",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-2xs leading-snug text-subtle",
					children: "Typed answers only. Jev does not size, compute indicators, or emit BUY/SELL. Active port is a deterministic mock until TypeSafe is wired."
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mb-1 flex items-baseline justify-between",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "kicker",
						children: "Regime choice"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "font-mono text-2xs text-subtle",
						children: ["conf ", fmtNum(a.REGIME.confidence, 2)]
					})]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Distro, {
					probs: a.REGIME.probabilities,
					chosen: a.REGIME.choice
				})] }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-1",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "kicker",
							children: "Noul"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(NoulRow, {
							label: "LONG_SETUP",
							p: a.LONG_SETUP.noul,
							pass: a.LONG_SETUP.noul >= THRESHOLDS.longSetupNoul
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(NoulRow, {
							label: "SHORT_SETUP",
							p: a.SHORT_SETUP.noul,
							pass: a.SHORT_SETUP.noul >= THRESHOLDS.shortSetupNoul
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(NoulRow, {
							label: "TREND",
							p: a.TREND.noul,
							pass: a.TREND.noul >= THRESHOLDS.trendNoul
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(NoulRow, {
							label: "MEAN_REVERSION",
							p: a.MEAN_REVERSION.noul,
							pass: a.MEAN_REVERSION.noul >= THRESHOLDS.meanReversionNoul
						})
					]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "kicker",
						children: "Market quality"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mt-1 flex items-baseline justify-between",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "font-mono text-sm text-fg",
							children: a.MARKET_QUALITY.level
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
							className: "tabular font-mono text-2xs text-muted",
							children: [
								"score ",
								fmtNum(a.MARKET_QUALITY.score, 2),
								" · conf",
								" ",
								fmtNum(a.MARKET_QUALITY.confidence, 2)
							]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Distro, {
						probs: a.MARKET_QUALITY.probabilities,
						chosen: a.MARKET_QUALITY.level
					})
				] }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
					className: "font-mono text-2xs text-warn",
					children: ["Gates ", THRESHOLDS.label]
				})
			]
		})
	});
}
var ROWS = [
	["Space", "Play / pause replay"],
	["← →", "Step one bar"],
	["Home / End", "First / last bar"],
	["1 2 3 4", "Experiment arms A–D"],
	["S", "Cycle strategy"],
	["E", "Inspect evidence"],
	["?", "This list"],
	["Esc", "Close overlays"]
];
function KeyboardHelp() {
	const open = useTerminal((s) => s.helpOpen);
	const toggle = useTerminal((s) => s.toggleHelp);
	if (!open) return null;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "fixed inset-0 z-50 grid place-items-center bg-bg/70 p-4",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
			type: "button",
			className: "absolute inset-0",
			"aria-label": "Close help",
			onClick: toggle
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "relative w-full max-w-md rounded-md border border-line bg-elevated p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
				className: "font-sans text-lg font-medium tracking-tight",
				children: "Keys"
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
				className: "mt-3 flex flex-col gap-1.5",
				children: ROWS.map(([k, v]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
					className: "flex justify-between gap-4 font-mono text-xs",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "text-fg",
						children: k
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "text-muted",
						children: v
					})]
				}, k))
			})]
		})]
	});
}
function MarketPanel() {
	const ev = useTerminal(selectEvidence);
	const session = useTerminal(selectSession);
	const cursor = useTerminal((s) => s.cursor);
	const candle = session.candles[cursor];
	const f = ev?.features;
	const first = session.candles[0]?.close ?? 1;
	const ret = candle && first ? candle.close / first - 1 : 0;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Panel, {
		title: "Market",
		meta: "closed bar",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", {
			className: "flex flex-col gap-1.5",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Kv, {
					k: "Last",
					v: fmtPx(candle?.close)
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Kv, {
					k: "Return",
					v: fmtPct(f?.logReturn),
					tone: f && f.logReturn > 0 ? "up" : f && f.logReturn < 0 ? "down" : "muted"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-baseline justify-between gap-3",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
						className: "font-mono text-2xs uppercase tracking-wider text-subtle",
						children: "Path"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
						className: `tabular font-mono text-sm ${signedClass(ret)}`,
						children: fmtPct(ret)
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Kv, {
					k: "Volume",
					v: fmtNum(candle?.volume, 0)
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Kv, {
					k: "Realized vol",
					v: fmtNum(f?.realizedVol, 4)
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Kv, {
					k: "Drawdown",
					v: fmtPct(f?.drawdown, 2),
					tone: f && f.drawdown > .08 ? "down" : "muted"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Kv, {
					k: "Norm. return",
					v: fmtNum(f?.normalizedReturn, 3)
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Kv, {
					k: "EMA px",
					v: fmtPx(f?.emaPrice)
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Kv, {
					k: "Disp. EMA",
					v: fmtPct(f?.displacementFromEma, 2),
					tone: f && f.displacementFromEma > 0 ? "up" : f && f.displacementFromEma < 0 ? "down" : "muted"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Kv, {
					k: "s_t (EMA r)",
					v: fmtNum(f?.emaReturnSignal, 4)
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Kv, {
					k: "RSI 14",
					v: fmtNum(f?.rsi14, 2)
				})
			]
		})
	});
}
var REGIME_FILL = {
	trend_up: "color-mix(in oklab, var(--color-up) 14%, transparent)",
	trend_down: "color-mix(in oklab, var(--color-down) 14%, transparent)",
	mean_reverting: "color-mix(in oklab, var(--color-warn) 12%, transparent)",
	ambiguous: "transparent"
};
function PriceChart() {
	const canvasRef = (0, import_react.useRef)(null);
	const session = useTerminal(selectSession);
	const cursor = useTerminal((s) => s.cursor);
	const setCursor = useTerminal((s) => s.setCursor);
	const playing = useTerminal((s) => s.playing);
	const togglePlay = useTerminal((s) => s.togglePlay);
	const step = useTerminal((s) => s.step);
	const ev = useTerminal(selectEvidence);
	(0, import_react.useEffect)(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const parent = canvas.parentElement;
		if (!parent) return;
		const draw = () => {
			const dpr = window.devicePixelRatio || 1;
			const w = parent.clientWidth;
			const h = parent.clientHeight;
			canvas.width = Math.max(1, Math.floor(w * dpr));
			canvas.height = Math.max(1, Math.floor(h * dpr));
			canvas.style.width = `${w}px`;
			canvas.style.height = `${h}px`;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			const styles = getComputedStyle(canvas);
			const fg = styles.getPropertyValue("--color-fg").trim() || "#e6e8ee";
			const muted = styles.getPropertyValue("--color-muted").trim() || "#8b919c";
			const up = styles.getPropertyValue("--color-up").trim() || "#6f9e86";
			const down = styles.getPropertyValue("--color-down").trim() || "#c17b74";
			const line = styles.getPropertyValue("--color-line").trim() || "#222";
			const accent = styles.getPropertyValue("--color-accent").trim() || "#b4bcc8";
			ctx.fillStyle = styles.getPropertyValue("--color-surface").trim() || "#0e1014";
			ctx.fillRect(0, 0, w, h);
			const pad = {
				l: 52,
				r: 10,
				t: 8,
				b: 28
			};
			const { candles, evidences } = session;
			const n = candles.length;
			if (n === 0) return;
			const windowSize = Math.min(96, n);
			const start = Math.max(0, Math.min(cursor - windowSize + 12, n - windowSize));
			const end = Math.min(n, start + windowSize);
			const count = end - start;
			const plotW = w - pad.l - pad.r;
			const plotH = h - pad.t - pad.b;
			const volH = plotH * .16;
			const priceH = plotH - volH - 6;
			let min = Infinity;
			let max = -Infinity;
			let maxVol = 1;
			for (let i = start; i < end; i++) {
				const c = candles[i];
				min = Math.min(min, c.low);
				max = Math.max(max, c.high);
				maxVol = Math.max(maxVol, c.volume);
			}
			const padY = (max - min) * .08 || 1;
			min -= padY;
			max += padY;
			const xAt = (i) => pad.l + (i - start + .5) / count * plotW;
			const yAt = (p) => pad.t + (max - p) / (max - min) * priceH;
			const slot = plotW / count;
			for (let i = start; i < end; i++) {
				const fill = REGIME_FILL[evidences[i]?.jevResponse.answers.REGIME.choice ?? "ambiguous"] ?? "transparent";
				if (fill === "transparent") continue;
				ctx.fillStyle = fill;
				ctx.fillRect(pad.l + (i - start) / count * plotW, pad.t, slot + .5, priceH);
			}
			ctx.strokeStyle = line;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(pad.l, pad.t);
			ctx.lineTo(pad.l, pad.t + priceH);
			ctx.lineTo(pad.l + plotW, pad.t + priceH);
			ctx.stroke();
			ctx.fillStyle = muted;
			ctx.font = "10px IBM Plex Mono, ui-monospace, monospace";
			ctx.textAlign = "right";
			ctx.textBaseline = "middle";
			for (let k = 0; k < 4; k++) {
				const p = min + (max - min) * k / 3;
				const y = yAt(p);
				ctx.fillText(p.toFixed(1), pad.l - 6, y);
			}
			const candleW = Math.max(2, slot * .7);
			for (let i = start; i < end; i++) {
				const c = candles[i];
				const x = xAt(i);
				const bull = c.close >= c.open;
				ctx.strokeStyle = bull ? up : down;
				ctx.fillStyle = bull ? up : down;
				ctx.beginPath();
				ctx.moveTo(x, yAt(c.high));
				ctx.lineTo(x, yAt(c.low));
				ctx.stroke();
				const y1 = yAt(Math.max(c.open, c.close));
				const y2 = yAt(Math.min(c.open, c.close));
				ctx.fillRect(x - candleW / 2, y1, candleW, Math.max(1, y2 - y1));
			}
			ctx.beginPath();
			ctx.strokeStyle = accent;
			ctx.lineWidth = 1.25;
			let started = false;
			for (let i = start; i < end; i++) {
				const ema = evidences[i]?.features.emaPrice;
				if (!ema) continue;
				const x = xAt(i);
				const y = yAt(ema);
				if (!started) {
					ctx.moveTo(x, y);
					started = true;
				} else ctx.lineTo(x, y);
			}
			ctx.stroke();
			for (const fill of session.fills) {
				const i = fill.fillBarIndex;
				if (i < start || i >= end) continue;
				const x = xAt(i);
				const y = yAt(candles[i].close);
				ctx.fillStyle = fill.action === "LONG" ? up : fill.action === "SHORT" ? down : muted;
				ctx.beginPath();
				if (fill.action === "LONG") {
					ctx.moveTo(x, y - 7);
					ctx.lineTo(x - 4, y);
					ctx.lineTo(x + 4, y);
				} else if (fill.action === "SHORT") {
					ctx.moveTo(x, y + 7);
					ctx.lineTo(x - 4, y);
					ctx.lineTo(x + 4, y);
				}
				ctx.closePath();
				ctx.fill();
			}
			const volTop = pad.t + priceH + 6;
			for (let i = start; i < end; i++) {
				const c = candles[i];
				const x = xAt(i);
				const vh = c.volume / maxVol * volH;
				ctx.fillStyle = c.close >= c.open ? up : down;
				ctx.globalAlpha = .45;
				ctx.fillRect(x - candleW / 2, volTop + volH - vh, candleW, vh);
				ctx.globalAlpha = 1;
			}
			const cx = xAt(cursor);
			ctx.strokeStyle = fg;
			ctx.globalAlpha = .35;
			ctx.beginPath();
			ctx.moveTo(cx, pad.t);
			ctx.lineTo(cx, pad.t + priceH);
			ctx.stroke();
			ctx.globalAlpha = 1;
			ctx.fillStyle = muted;
			ctx.textAlign = "left";
			ctx.textBaseline = "top";
			ctx.fillText(fmtUtcShort(candles[start].t), pad.l, h - 16);
			ctx.textAlign = "right";
			ctx.fillText(fmtUtcShort(candles[end - 1].t), pad.l + plotW, h - 16);
		};
		draw();
		const ro = new ResizeObserver(draw);
		ro.observe(parent);
		return () => ro.disconnect();
	}, [session, cursor]);
	const onClick = (e) => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const padL = 52;
		const padR = 10;
		const n = session.candles.length;
		const windowSize = Math.min(96, n);
		const start = Math.max(0, Math.min(cursor - windowSize + 12, n - windowSize));
		const count = Math.min(n, start + windowSize) - start;
		const i = start + Math.floor((x - padL) / (rect.width - padL - padR) * count);
		if (i >= 0 && i < n) setCursor(i);
	};
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
		className: "flex min-h-0 min-w-0 flex-col bg-surface",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
				className: "flex h-7 shrink-0 items-center justify-between gap-2 border-b border-line px-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "kicker",
					children: "Price"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2 font-mono text-2xs text-muted",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: ["EMA ", THRESHOLDS.priceEmaSpan] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: ["cursor ", fmtPx(ev?.marketSnapshot.close)] })]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "relative min-h-56 flex-1",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("canvas", {
					ref: canvasRef,
					className: "absolute inset-0 h-full w-full",
					onClick,
					role: "img",
					"aria-label": "Candlestick chart of the synthetic replay series"
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex h-10 shrink-0 items-center gap-1 border-t border-line px-2",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						className: "grid size-8 place-items-center rounded-sm font-mono text-xs text-muted hover:bg-elevated hover:text-fg",
						onClick: () => setCursor(0),
						children: "|<"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						className: "grid size-8 place-items-center rounded-sm font-mono text-xs text-muted hover:bg-elevated hover:text-fg",
						onClick: () => step(-1),
						children: "<"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						className: "h-8 min-w-16 rounded-sm bg-fg px-3 font-mono text-2xs font-medium text-accent-fg active:scale-[0.96]",
						onClick: togglePlay,
						children: playing ? "Pause" : "Replay"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						className: "grid size-8 place-items-center rounded-sm font-mono text-xs text-muted hover:bg-elevated hover:text-fg",
						onClick: () => step(1),
						children: ">"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						className: "grid size-8 place-items-center rounded-sm font-mono text-xs text-muted hover:bg-elevated hover:text-fg",
						onClick: () => setCursor(session.candles.length - 1),
						children: ">|"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "ml-auto font-mono text-2xs text-subtle",
						children: [
							cursor + 1,
							"/",
							session.candles.length
						]
					})
				]
			})
		]
	});
}
var RESEARCH = {
	ema_trend: {
		id: "ema_trend",
		paper: {
			authors: "Grebenkov & Serror",
			title: "Following a Trend with an Exponential Moving Average: Analytical Results for a Gaussian Model",
			arxiv: "1308.5658",
			year: "2013"
		},
		hypothesis: "Under a Gaussian model of log returns with autocorrelation, a trend-following signal formed as an EMA of past returns has an analyzable P&L distribution (often small losses, less frequent larger profits). They derive moments, turnover, and an optimal timescale that depends on autocorrelation and transaction costs. Illustrated on the Dow Jones index. They do not claim live profitability, and they note quantitative results are model-dependent (heavy tails ignored).",
		implementation: "We compute s_t = γ Σ_{k<t} (1-η)^{t-1-k} r_k with γ² = η(2-η) as in their eq. (13), using only past returns. η = 0.05 is UNCALIBRATED (illustrative 20-bar inverse timescale), not their Dow Jones market-model fit λ ≈ 0.011. They trade a linear position in s_t; we discretize with an UNCALIBRATED |s_t|/realized_vol enter floor because our returns are not pre-standardized. Paper fill is next-bar close. Synthetic path, not Dow Jones.",
		observed: "Observed numbers on this screen are in-sample on a seeded synthetic series. They are not a test of Grebenkov & Serror and are not alpha."
	},
	rsi_mean_reversion: {
		id: "rsi_mean_reversion",
		paper: {
			authors: "Khaidem, Saha & Dey; Kakushadze; Deep et al.",
			title: "RSI as a classification feature; mean-reversion via demeaning; indicator impact OOS",
			arxiv: "1605.00003 / 1408.2217 / 2412.15448",
			year: "2016–2024"
		},
		hypothesis: "Khaidem et al. (arXiv:1605.00003) use RSI(14) = 100 − 100/(1+RS) with RS = average gain / average loss over 14 days as an input to a random forest for direction classification — not as an oversold/overbought trading rule. Kakushadze (arXiv:1408.2217) treats mean-reversion as cross-sectional demeaning of returns (pairs / regression residuals), which a single series cannot implement. Deep et al. (arXiv:2412.15448) find that on minute SPY, RSI and similar indicators contribute ~14–15% of RF importance vs >60% for price features; OOS R² turns negative; indicator-enhanced models underperformed buy-and-hold (−2.4% to −3.9% in their test).",
		implementation: "We compute Khaidem's RSI(14) SMA on one synthetic series. The long-if-RSI≤30 / short-if-RSI≥70 gate is OUR conventional heuristic, UNCALIBRATED, and is not a finding of those papers. Displacement from price EMA is a time-series demeaning analog, not Kakushadze's cross-sectional residual.",
		observed: "Do not read a profitable RSI rule out of this replay. Deep et al. already warn that in-sample indicator fits can collapse OOS."
	},
	evaluation: {
		id: "evaluation",
		paper: {
			authors: "Mroziewicz & Ślepaczuk",
			title: "A novel approach to trading strategy parameter optimization using double out-of-sample data and walk-forward techniques",
			arxiv: "2602.10785",
			year: "2026"
		},
		hypothesis: "Walk-forward window lengths (train/test) are themselves parameters. They evaluate an EMA strategy on intraday Bitcoin with 81 window combinations, then apply the two best sets once on a later 21-month OOS period, and transfer parameters to BNB and ETH. They include 0.1% fees and a cost-sensitivity check (break-even around 0.4%/transaction in their study). This is a methodology paper.",
		implementation: "Sprint 0 does NOT run their double-OOS walk-forward. Arms A–D share one synthetic path (in-sample contamination if treated as a result). Transaction cost = 0 bps UNCALIBRATED. Architecture exposes the four arms and the metric set so that procedure can be added next.",
		observed: "Any Sharpe/return on this screen is an in-sample synthetic diagnostic, not an OOS result and not a claim that walk-forward was performed."
	},
	indicators: {
		id: "indicators",
		paper: {
			authors: "Deep et al.",
			title: "Assessing the Impact of Technical Indicators on Machine Learning Models for Stock Price Prediction",
			arxiv: "2412.15448",
			year: "2024"
		},
		hypothesis: "On minute-level SPY, adding established technical indicators (RSI, Bollinger, …) to RF regression did not yield OOS predictive skill. Price-based features dominated importance. Authors suggest indicators may be more relevant to risk management than to return prediction in that high-frequency setting, and stress robust OOS testing.",
		implementation: "We keep a small feature set (EMA-return signal, RSI14, realized vol, normalized return, EMA displacement) and do not train an RF. Jev sees already-computed numbers only.",
		observed: "No ML price-prediction model is fit here. Feature values are diagnostics, not a forecast."
	}
};
function cardForStrategy(id) {
	return RESEARCH[id];
}
function ResearchPanel() {
	const strategyId = useTerminal((s) => s.strategyId);
	const arm = useTerminal((s) => s.arm);
	const sessions = useTerminal((s) => s.sessions);
	const session = useTerminal(selectSession);
	const card = cardForStrategy(strategyId);
	const evalCard = RESEARCH.evaluation;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Panel, {
		title: "Research",
		meta: `arXiv:${card.paper.arxiv}`,
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col gap-3 text-xs leading-snug",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "kicker",
					children: "Paper"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
					className: "mt-1 text-fg",
					children: [
						card.paper.authors,
						" (",
						card.paper.year,
						"). ",
						card.paper.title,
						"."
					]
				})] }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Block, {
					label: "Research hypothesis",
					body: card.hypothesis
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Block, {
					label: "Our implementation",
					body: card.implementation
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Block, {
					label: "Observed result",
					body: `${card.observed} This arm ${arm} (${EXPERIMENT_ARMS[arm].label}): total return ${fmtPct(session.metrics.totalReturn)} · Sharpe ${fmtNum(session.metrics.sharpe, 2)} · max DD ${fmtPct(session.metrics.maxDrawdown)} · trades ${session.metrics.tradeCount}.`
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "kicker",
					children: "Arm comparison · synthetic in-sample"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", {
					className: "mt-1 w-full font-mono text-2xs",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", {
						className: "text-subtle",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
								className: "py-1 text-left font-medium",
								children: "Arm"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
								className: "text-right font-medium",
								children: "Ret"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
								className: "text-right font-medium",
								children: "Sh"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
								className: "text-right font-medium",
								children: "DD"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", {
								className: "text-right font-medium",
								children: "N"
							})
						] })
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: [
						"A",
						"B",
						"C",
						"D"
					].map((id) => {
						const m = sessions[id].metrics;
						return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", {
							className: id === arm ? "text-fg" : "text-muted",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
									className: "py-0.5",
									children: id
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
									className: "tabular text-right",
									children: fmtPct(m.totalReturn, 1)
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
									className: "tabular text-right",
									children: fmtNum(m.sharpe, 2)
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
									className: "tabular text-right",
									children: fmtPct(m.maxDrawdown, 1)
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", {
									className: "tabular text-right",
									children: m.tradeCount
								})
							]
						}, id);
					}) })]
				})] }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Block, {
					label: "Evaluation method (deferred)",
					body: evalCard.implementation
				})
			]
		})
	});
}
function Block({ label, body }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "kicker",
		children: label
	}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
		className: "mt-1 text-pretty text-muted",
		children: body
	})] });
}
var STRATEGIES = [{
	id: "ema_trend",
	label: "EMA trend"
}, {
	id: "rsi_mean_reversion",
	label: "RSI mean-rev"
}];
function StrategyPanel() {
	const ev = useTerminal(selectEvidence);
	const strategyId = useTerminal((s) => s.strategyId);
	const setStrategy = useTerminal((s) => s.setStrategy);
	const arm = useTerminal((s) => s.arm);
	const setArm = useTerminal((s) => s.setArm);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Panel, {
		title: "Strategy",
		meta: ev?.strategyVersion,
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col gap-2",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "flex gap-1",
					children: STRATEGIES.map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => setStrategy(s.id),
						className: cn("h-8 flex-1 rounded-sm px-2 font-mono text-2xs transition-colors duration-150 ease-out", strategyId === s.id ? "bg-fg text-accent-fg" : "bg-elevated text-muted hover:text-fg"),
						children: s.label
					}, s.id))
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "grid grid-cols-4 gap-1 lg:hidden",
					children: [
						"A",
						"B",
						"C",
						"D"
					].map((id) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => setArm(id),
						className: cn("h-8 rounded-sm font-mono text-2xs", arm === id ? "bg-fg text-accent-fg" : "bg-elevated text-muted"),
						children: id
					}, id))
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-2xs leading-snug text-subtle",
					children: EXPERIMENT_ARMS[arm].summary
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Gate, {
					k: "Candidate",
					v: strategyId === "ema_trend" ? "EMA trend s_t" : "RSI(14) MR"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Gate, {
					k: "Det. signal",
					v: ev?.deterministicSignal.desired ?? "—"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Gate, {
					k: "Det. regime",
					v: ev?.deterministicRegime ?? "—"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Gate, {
					k: "Jev gate",
					v: jevGateLabel(ev?.policy.arm, ev?.action, ev?.policy.reason)
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Gate, {
					k: "Risk gate",
					v: ev?.risk.pass ? "pass" : ev?.risk.reasons[0] ?? "block",
					warn: ev ? !ev.risk.pass : false
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Gate, {
					k: "Final action",
					v: ev?.action ?? "—",
					strong: true
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
					className: "font-mono text-2xs text-warn",
					children: [
						"|s|/vol ",
						THRESHOLDS.emaSignalEnterZ,
						" · RSI ",
						THRESHOLDS.rsiOversold,
						"/",
						THRESHOLDS.rsiOverbought,
						" ",
						THRESHOLDS.label
					]
				})
			]
		})
	});
}
function jevGateLabel(arm, _action, reason) {
	if (!arm) return "—";
	if (arm === "A" || arm === "B") return "not used";
	if (arm === "C") return "det. filter (not Jev)";
	return reason?.startsWith("Arm D") ? reason.replace("Arm D: ", "") : "Jev";
}
function Gate({ k, v, strong, warn }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-start justify-between gap-2",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
			className: "font-mono text-2xs uppercase tracking-wider text-subtle",
			children: k
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
			className: cn("w-2/3 text-right font-mono text-2xs leading-snug", strong ? "text-fg" : "text-muted", warn && "text-warn"),
			children: v
		})]
	});
}
var ARMS = [
	"A",
	"B",
	"C",
	"D"
];
function TopBar() {
	const arm = useTerminal((s) => s.arm);
	const setArm = useTerminal((s) => s.setArm);
	const toggleHelp = useTerminal((s) => s.toggleHelp);
	const ev = useTerminal(selectEvidence);
	const ts = ev?.timestamp ?? 0;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
		className: "flex h-10 shrink-0 items-center gap-2 border-b border-line bg-elevated px-2 text-xs md:gap-3 md:px-3",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 pr-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					className: "grid size-5 place-items-center rounded-xs bg-fg font-mono text-2xs font-semibold text-accent-fg",
					"aria-hidden": true,
					children: "LL"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					className: "font-sans text-sm font-semibold tracking-tight",
					children: "LIGHTLIGHT"
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "hidden h-4 w-px bg-line-strong sm:block" }),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 font-mono text-2xs md:text-xs",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "text-fg",
						children: ev?.symbol ?? "SYN.LL1"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "text-subtle",
						children: "1D"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "rounded-xs bg-elevated px-1.5 py-0.5 text-warn ring-1 ring-line-strong",
						children: "SYNTHETIC"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "rounded-xs bg-paper/15 px-1.5 py-0.5 text-paper ring-1 ring-paper/30",
						children: "PAPER"
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "ml-auto flex min-w-0 items-center gap-1 overflow-x-auto md:gap-2",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mr-1 hidden items-center gap-1 lg:flex",
						children: ARMS.map((id) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => setArm(id),
							className: cn("h-8 min-w-8 rounded-sm px-2 font-mono text-2xs tracking-wide transition-colors duration-150 ease-out active:scale-[0.96]", arm === id ? "bg-fg text-accent-fg" : "text-muted hover:bg-surface hover:text-fg"),
							title: EXPERIMENT_ARMS[id].label,
							children: id
						}, id))
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "hidden font-mono text-2xs text-subtle xl:inline",
						children: EXPERIMENT_ARMS[arm].label
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("time", {
						className: "tabular font-mono text-2xs text-muted md:text-xs",
						dateTime: ts ? fmtUtc(ts) : void 0,
						children: ts ? fmtUtc(ts) : "—"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: toggleHelp,
						className: "grid size-10 place-items-center rounded-sm text-muted hover:bg-surface hover:text-fg",
						"aria-label": "Keyboard shortcuts",
						children: "?"
					})
				]
			})
		]
	});
}
function Terminal() {
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
	(0, import_react.useEffect)(() => {
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
	(0, import_react.useEffect)(() => {
		const onKey = (e) => {
			const t = e.target;
			if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
			if (e.key === "?" || e.key === "/" && e.shiftKey) {
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
			if (e.key === "s" || e.key === "S") setStrategy(strategyId === "ema_trend" ? "rsi_mean_reversion" : "ema_trend");
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
		togglePlay
	]);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex h-dvh min-h-0 flex-col bg-bg text-fg",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(TopBar, {}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "shrink-0 border-b border-line bg-surface px-3 py-1 font-mono text-2xs text-warn",
				children: "PAPER / REPLAY ONLY · synthetic seeded series · Jev port is a mock · not a live model, not a broker, not a performance claim"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "hidden min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)_280px] grid-rows-[minmax(0,1fr)_minmax(200px,240px)] lg:grid [&>*]:min-h-0 [&>*]:min-w-0 [&>*]:border-r [&>*]:border-b [&>*]:border-line",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(MarketPanel, {}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(PriceChart, {}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(JevPanel, {}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(StrategyPanel, {}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DecisionTrace, {}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ResearchPanel, {})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-h-0 flex-1 flex-col lg:hidden",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "min-h-0 flex-1 overflow-hidden",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: cn("h-full", mobileTab !== "chart" && "hidden"),
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "grid h-full grid-rows-[minmax(0,1fr)_auto]",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(PriceChart, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "max-h-40 overflow-auto border-t border-line",
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MarketPanel, {})
								})]
							})
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: cn("h-full", mobileTab !== "jev" && "hidden"),
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(JevPanel, {})
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: cn("h-full", mobileTab !== "trace" && "hidden"),
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "grid h-full grid-rows-2",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(StrategyPanel, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DecisionTrace, {})]
							})
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: cn("h-full", mobileTab !== "research" && "hidden"),
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ResearchPanel, {})
						})
					]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("nav", {
					className: "grid h-12 shrink-0 grid-cols-4 border-t border-line bg-elevated",
					children: [
						"chart",
						"jev",
						"trace",
						"research"
					].map((tab) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => setMobileTab(tab),
						className: cn("font-mono text-2xs uppercase tracking-wider", mobileTab === tab ? "text-fg" : "text-subtle"),
						children: tab
					}, tab))
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(EvalStrip, {}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(EvidenceDrawer, {}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(KeyboardHelp, {})
		]
	});
}
function Home() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Terminal, {});
}
//#endregion
export { Home as component };

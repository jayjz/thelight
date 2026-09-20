import { create } from "zustand";
import { generateSyntheticCandles } from "./candles.ts";
import { runAllArms } from "./pipeline.ts";
import type {
  Evidence,
  ExperimentArm,
  SessionResult,
  StrategyId,
} from "./types.ts";

const candles = generateSyntheticCandles();

function sessionsFor(strategyId: StrategyId) {
  return runAllArms(strategyId, candles);
}

type TerminalState = {
  strategyId: StrategyId;
  arm: ExperimentArm;
  cursor: number;
  playing: boolean;
  helpOpen: boolean;
  evidenceOpen: boolean;
  selectedId: string | null;
  mobileTab: "chart" | "jev" | "trace" | "research";
  sessions: Record<ExperimentArm, SessionResult>;
  setStrategy: (id: StrategyId) => void;
  setArm: (arm: ExperimentArm) => void;
  setCursor: (i: number) => void;
  step: (delta: number) => void;
  togglePlay: () => void;
  setPlaying: (v: boolean) => void;
  toggleHelp: () => void;
  openEvidence: (id?: string) => void;
  closeEvidence: () => void;
  setMobileTab: (tab: TerminalState["mobileTab"]) => void;
};

function lastWarm(session: SessionResult): number {
  const i = session.evidences.findIndex((e) => e.features.warmupComplete);
  return i < 0 ? 40 : i;
}

const initialSessions = sessionsFor("ema_trend");

export const useTerminal = create<TerminalState>((set, get) => ({
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
      cursor: Math.min(get().cursor, sessions[arm].candles.length - 1),
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
    const session = get().sessions[get().arm];
    const fallback = session.evidences[get().cursor]?.id ?? null;
    set({ evidenceOpen: true, selectedId: id ?? fallback });
  },
  closeEvidence: () => set({ evidenceOpen: false }),
  setMobileTab: (tab) => set({ mobileTab: tab }),
}));

export function selectSession(s: TerminalState): SessionResult {
  return s.sessions[s.arm];
}

export function selectEvidence(s: TerminalState): Evidence | undefined {
  return s.sessions[s.arm].evidences[s.cursor];
}

export function selectById(s: TerminalState, id: string | null): Evidence | undefined {
  if (!id) return undefined;
  return s.sessions[s.arm].evidences.find((e) => e.id === id);
}

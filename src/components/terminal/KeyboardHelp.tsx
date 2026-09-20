import { useTerminal } from "@/lib/lightlight/store";

const ROWS: [string, string][] = [
  ["Space", "Play / pause replay"],
  ["← →", "Step one bar"],
  ["Home / End", "First / last bar"],
  ["1 2 3 4", "Experiment arms A–D"],
  ["S", "Cycle strategy"],
  ["E", "Inspect evidence"],
  ["?", "This list"],
  ["Esc", "Close overlays"],
];

export function KeyboardHelp() {
  const open = useTerminal((s) => s.helpOpen);
  const toggle = useTerminal((s) => s.toggleHelp);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg/70 p-4">
      <button type="button" className="absolute inset-0" aria-label="Close help" onClick={toggle} />
      <div className="relative w-full max-w-md rounded-md border border-line bg-elevated p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
        <h2 className="font-sans text-lg font-medium tracking-tight">Keys</h2>
        <ul className="mt-3 flex flex-col gap-1.5">
          {ROWS.map(([k, v]) => (
            <li key={k} className="flex justify-between gap-4 font-mono text-xs">
              <span className="text-fg">{k}</span>
              <span className="text-muted">{v}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

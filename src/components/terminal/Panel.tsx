import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({
  title,
  meta,
  children,
  className,
}: {
  title: string;
  meta?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden border-line bg-surface",
        className,
      )}
    >
      <header className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-line px-2">
        <h2 className="kicker">{title}</h2>
        {meta ? (
          <span className="truncate font-mono text-2xs text-subtle">{meta}</span>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2">{children}</div>
    </section>
  );
}

export function Kv({
  k,
  v,
  tone,
}: {
  k: string;
  v: string;
  tone?: "up" | "down" | "muted" | "warn";
}) {
  const color =
    tone === "up"
      ? "text-up"
      : tone === "down"
        ? "text-down"
        : tone === "warn"
          ? "text-warn"
          : "text-fg";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-mono text-2xs uppercase tracking-wider text-subtle">{k}</dt>
      <dd className={cn("tabular font-mono text-sm", color)}>{v}</dd>
    </div>
  );
}

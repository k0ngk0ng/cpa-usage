import { ReactNode } from "react";
import clsx from "clsx";

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "success" | "danger" | "accent";
}

const TONE: Record<NonNullable<Props["tone"]>, string> = {
  default: "text-ink",
  success: "text-success",
  danger: "text-danger",
  accent: "text-accent",
};

export default function MetricCard({ label, value, hint, tone = "default" }: Props) {
  return (
    <div className="bg-panel border border-border rounded-lg px-4 py-3">
      <div className="text-xs text-muted uppercase tracking-wider">{label}</div>
      <div className={clsx("text-2xl font-semibold mt-1 tabular-nums", TONE[tone])}>{value}</div>
      {hint != null && <div className="text-xs text-muted mt-1">{hint}</div>}
    </div>
  );
}

import { ArrowRight, Check } from "lucide-react";
import type { ConceptPreview } from "./short-drama-preview-data";

export function Status({
  label,
  value,
  positive = false,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <div className="status-row">
      <span>{label}</span>
      <strong className={positive ? "positive" : ""}>
        {positive && <Check size={12} />} {value}
      </strong>
    </div>
  );
}
export function stateName(state: ConceptPreview["state"]) {
  return state === "draft" ? "草稿" : state === "queued" ? "排队中" : "已完成";
}
export function ArrowUpRight() {
  return <ArrowRight size={14} style={{ transform: "rotate(-45deg)" }} />;
}

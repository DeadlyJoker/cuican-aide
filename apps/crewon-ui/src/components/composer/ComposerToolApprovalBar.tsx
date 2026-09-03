import { LoaderCircle, ShieldAlert } from "lucide-react";

import type {
  ControlToolApprovalPrompt,
  ControlToolApprovalRequest,
} from "../../lib/control-runtime/controlToolApprovalPresentation";
import type { Locale } from "../../lib/i18n";

export function ComposerToolApprovalBar({
  approval,
  locale,
  onDecision,
}: {
  approval: ControlToolApprovalPrompt;
  locale: Locale;
  onDecision: (
    approval: ControlToolApprovalRequest,
    decision: "approved" | "rejected",
  ) => void;
}) {
  const isZh = locale === "zh";
  const toolLabel = approval.toolName ?? (isZh ? "当前工具" : "current tool");

  return (
    <section
      aria-busy={approval.busy}
      aria-live="polite"
      className="composer-tool-approval"
      data-od-id="composer-tool-approval"
      role="alert"
    >
      <div className="composer-tool-approval-copy">
        {approval.busy ? (
          <LoaderCircle aria-hidden="true" className="spin" />
        ) : (
          <ShieldAlert aria-hidden="true" />
        )}
        <div>
          <strong>
            {approval.busy
              ? isZh
                ? "正在提交审批决定"
                : "Submitting approval decision"
              : isZh
                ? "工具调用等待批准"
                : "Tool call waiting for approval"}
          </strong>
          <span>
            {isZh
              ? `${toolLabel} 尚未开始执行，请先检查上方调用参数。`
              : `${toolLabel} has not started. Review the call arguments above first.`}
          </span>
        </div>
      </div>
      <div className="composer-tool-approval-actions">
        <button
          className="composer-tool-approval-reject"
          disabled={approval.busy}
          type="button"
          onClick={() => onDecision(approval, "rejected")}
        >
          {isZh ? "拒绝" : "Reject"}
        </button>
        <button
          className="composer-tool-approval-approve"
          disabled={approval.busy}
          type="button"
          onClick={() => onDecision(approval, "approved")}
        >
          {isZh ? "批准并继续" : "Approve and continue"}
        </button>
      </div>
      {approval.error ? (
        <p className="composer-tool-approval-error">{approval.error}</p>
      ) : null}
    </section>
  );
}

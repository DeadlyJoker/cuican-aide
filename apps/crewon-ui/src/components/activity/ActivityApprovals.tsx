import type {
  ApprovalRequest,
} from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

function riskLabel(risk: ApprovalRequest["risk"], locale: Locale) {
  return locale === "zh"
    ? { low: "低风险", medium: "中风险", high: "高风险" }[risk]
    : { low: "Low", medium: "Medium", high: "High" }[risk];
}

type ActivityApprovalsProps = {
  approvals: ApprovalRequest[];
  locale: Locale;
  onDecision: (id: string, decision: "approved" | "denied") => void;
};

export function ActivityApprovals({
  approvals,
  locale,
  onDecision,
}: ActivityApprovalsProps) {
  const isZh = locale === "zh";
  const pendingApprovals = approvals.filter((approval) => !approval.decision);

  return (
    <section className="activity-card activity-approvals">
      <div className="activity-card-head">
        <h2>{isZh ? "审批收件箱" : "Approvals inbox"}</h2>
        <span
          className="approvals-count"
          data-empty={pendingApprovals.length === 0}
        >
          {pendingApprovals.length}
        </span>
      </div>
      {pendingApprovals.length === 0 ? (
        <p className="activity-empty">
          {isZh ? "没有待处理的审批。" : "No pending approvals."}
        </p>
      ) : null}
      <div className="approval-list">
        {approvals.map((req) => (
          <article
            className="approval-row"
            data-risk={req.risk}
            data-decision={req.decision ?? "pending"}
            key={req.id}
          >
            <span
              className="approval-glyph"
              data-accent={req.accent}
              aria-hidden="true"
            >
              {req.glyph}
            </span>
            <div className="approval-body">
              <div className="approval-top">
                <strong>{req.actor}</strong>
                <span className="approval-risk" data-risk={req.risk}>
                  {riskLabel(req.risk, locale)}
                </span>
              </div>
              <p className="approval-action">{req.action}</p>
              <p className="approval-detail">{req.detail}</p>
              {req.decision ? (
                <span
                  className="approval-decided"
                  data-decision={req.decision}
                >
                  {req.decision === "approved"
                    ? isZh
                      ? "已批准"
                      : "Approved"
                    : isZh
                      ? "已拒绝"
                      : "Denied"}
                </span>
              ) : (
                <div className="approval-actions">
                  <button
                    type="button"
                    className="approval-approve"
                    onClick={() => onDecision(req.id, "approved")}
                  >
                    {isZh ? "批准" : "Approve"}
                  </button>
                  <button
                    type="button"
                    className="approval-deny"
                    onClick={() => onDecision(req.id, "denied")}
                  >
                    {isZh ? "拒绝" : "Deny"}
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

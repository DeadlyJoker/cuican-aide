import type { Locale } from "../../lib/i18n";
import type {
  ActivityData,
  ApprovalRequest,
  ArtifactItem,
  TraceStep,
} from "../../lib/crewonDomain";

function tokensLabel(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${n} tok`;
}

export function ActivityBoard({
  data,
  locale,
  onDecision,
  onArtifact,
}: {
  data: ActivityData;
  locale: Locale;
  onDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
}) {
  const isZh = locale === "zh";
  const totalCost = data.budget.reduce((sum, row) => sum + row.costUsd, 0);
  const capPct = Math.min(
    100,
    Math.round((totalCost / data.budgetCapUsd) * 100),
  );
  const pendingApprovals = data.approvals.filter((a) => !a.decision);
  const riskLabel = (risk: ApprovalRequest["risk"]) =>
    isZh
      ? { low: "低风险", medium: "中风险", high: "高风险" }[risk]
      : { low: "Low", medium: "Medium", high: "High" }[risk];
  const statusLabel = (status: TraceStep["status"]) =>
    isZh
      ? { done: "完成", running: "进行中", waiting: "等待" }[status]
      : { done: "Done", running: "Running", waiting: "Waiting" }[status];

  return (
    <div className="activity-board">
      <section className="activity-card activity-trace">
        <div className="activity-card-head">
          <h2>{isZh ? "执行轨迹" : "Execution trace"}</h2>
          <span>{isZh ? "实时" : "Live"}</span>
        </div>
        <ol className="trace-timeline">
          {data.trace.map((step, idx) => (
            <li
              className="trace-step"
              data-status={step.status}
              key={`${step.time}:${idx}`}
            >
              <span
                className="trace-glyph"
                data-accent={step.accent}
                aria-hidden="true"
              >
                {step.glyph}
              </span>
              <div className="trace-body">
                <div className="trace-top">
                  <strong>{step.actor}</strong>
                  <span className="trace-action">{step.action}</span>
                  <span className="trace-time">{step.time}</span>
                </div>
                <p className="trace-detail">{step.detail}</p>
                <div className="trace-meta">
                  <span className="trace-status" data-status={step.status}>
                    {statusLabel(step.status)}
                  </span>
                  {step.tokens ? (
                    <span className="trace-tokens">
                      {tokensLabel(step.tokens)}
                    </span>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="activity-rail">
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
            {data.approvals.map((req) => (
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
                      {riskLabel(req.risk)}
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

        <section className="activity-card activity-budget">
          <div className="activity-card-head">
            <h2>{isZh ? "用量与预算" : "Usage & budget"}</h2>
            <span>{`$${totalCost.toFixed(2)} / $${data.budgetCapUsd.toFixed(0)}`}</span>
          </div>
          <div className="budget-cap">
            <div className="budget-cap-bar">
              <span style={{ width: `${capPct}%` }} data-warn={capPct >= 80} />
            </div>
            <span className="budget-cap-label">
              {isZh
                ? `本日预算已用 ${capPct}%`
                : `${capPct}% of daily budget used`}
            </span>
          </div>
          <div className="budget-list">
            {data.budget.map((row) => {
              const pct = Math.min(
                100,
                Math.round((row.usedTokens / row.budgetTokens) * 100),
              );
              return (
                <div className="budget-row" key={row.name}>
                  <span
                    className="budget-glyph"
                    data-accent={row.accent}
                    aria-hidden="true"
                  >
                    {row.glyph}
                  </span>
                  <div className="budget-row-main">
                    <div className="budget-row-top">
                      <span className="budget-name">{row.name}</span>
                      <span className="budget-cost">{`$${row.costUsd.toFixed(2)}`}</span>
                    </div>
                    <div className="budget-bar">
                      <span
                        style={{ width: `${pct}%` }}
                        data-warn={pct >= 80}
                      />
                    </div>
                    <span className="budget-tokens">{`${tokensLabel(row.usedTokens)} / ${tokensLabel(row.budgetTokens)}`}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="activity-card activity-artifacts">
          <div className="activity-card-head">
            <h2>{isZh ? "产物" : "Artifacts"}</h2>
            <span>{data.artifacts.length}</span>
          </div>
          <div className="artifact-list">
            {data.artifacts.map((art) => (
              <button
                type="button"
                className="artifact-row"
                key={art.title}
                onClick={() => onArtifact(art)}
              >
                <span
                  className="artifact-glyph"
                  data-accent={art.accent}
                  aria-hidden="true"
                >
                  {art.glyph}
                </span>
                <div className="artifact-body">
                  <div className="artifact-top">
                    <strong>{art.title}</strong>
                    <span className="artifact-kind">{art.kind}</span>
                  </div>
                  <p className="artifact-meta">{art.meta}</p>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

import type { Locale } from "../../lib/i18n";
import type { OfficeRunActivity } from "../../lib/domain/crewonDomain";

function runStatusLabel(status: OfficeRunActivity["status"], locale: Locale) {
  return locale === "zh"
    ? {
        queued: "排队中",
        running: "运行中",
        canceling: "取消中",
        completed: "已完成",
        failed: "失败",
        interrupted: "已中断",
      }[status]
    : {
        queued: "Queued",
        running: "Running",
        canceling: "Canceling",
        completed: "Completed",
        failed: "Failed",
        interrupted: "Interrupted",
      }[status];
}

function planStatusLabel(status: string | undefined, locale: Locale) {
  return locale === "zh"
    ? status === "completed"
      ? "完成"
      : status === "inProgress"
        ? "进行中"
        : "待办"
    : status === "completed"
      ? "Done"
      : status === "inProgress"
        ? "Running"
        : "Pending";
}

type ActivityOfficeRunsProps = {
  locale: Locale;
  runs: OfficeRunActivity[];
  onRunCancel?: (run: OfficeRunActivity) => void;
  onRunRetry?: (run: OfficeRunActivity) => void;
};

export function ActivityOfficeRuns({
  locale,
  runs,
  onRunCancel,
  onRunRetry,
}: ActivityOfficeRunsProps) {
  if (runs.length === 0) {
    return null;
  }

  const isZh = locale === "zh";

  return (
    <section className="activity-card activity-runs">
      <div className="activity-card-head">
        <h2>{isZh ? "团队执行" : "Team runs"}</h2>
        <span>{runs.length}</span>
      </div>
      <div className="office-run-list">
        {runs.slice(0, 5).map((run) => {
          const detail = run.error ?? run.resultPreview ?? run.promptPreview;
          const canCancel =
            run.status === "running" && Boolean(run.turnId && onRunCancel);
          const canRetry =
            ["completed", "failed", "interrupted"].includes(run.status) &&
            Boolean(onRunRetry);
          const meta = [
            run.turnId ? `turn ${run.turnId}` : null,
            run.retryOf ? `${isZh ? "重试" : "retry"} ${run.retryOf}` : null,
            run.updatedAt ?? run.completedAt ?? run.createdAt ?? null,
          ]
            .filter(Boolean)
            .join(" · ");

          return (
            <article
              className="office-run-row"
              data-status={run.status}
              key={run.id}
            >
              <div className="office-run-top">
                <strong>{run.title}</strong>
                <span className="office-run-status" data-status={run.status}>
                  {runStatusLabel(run.status, locale)}
                </span>
              </div>
              {meta ? <p className="office-run-meta">{meta}</p> : null}
              {run.goal ? (
                <p className="office-run-goal">
                  <span>{isZh ? "目标" : "Goal"}</span>
                  {run.goal}
                </p>
              ) : null}
              {detail ? <p className="office-run-detail">{detail}</p> : null}
              {run.plan?.length ? (
                <ol className="office-run-plan">
                  {run.plan.slice(0, 4).map((item, idx) => (
                    <li
                      data-status={item.status ?? "pending"}
                      key={`${item.step}:${idx}`}
                    >
                      <span>{planStatusLabel(item.status, locale)}</span>
                      <strong>{item.step}</strong>
                    </li>
                  ))}
                </ol>
              ) : null}
              {run.delegations?.length ? (
                <div className="office-run-delegations">
                  {run.delegations.slice(0, 4).map((delegation, idx) => (
                    <span key={`${delegation.member ?? "agent"}:${idx}`}>
                      <strong>{delegation.member ?? "Agent"}</strong>
                      {delegation.agentId ? ` · ${delegation.agentId}` : ""}
                      {delegation.task ? ` · ${delegation.task}` : ""}
                      {delegation.status ? ` · ${delegation.status}` : ""}
                    </span>
                  ))}
                </div>
              ) : null}
              {canCancel || canRetry || run.status === "canceling" ? (
                <div className="office-run-actions">
                  {run.status === "canceling" ? (
                    <button type="button" disabled>
                      {isZh ? "取消中" : "Canceling"}
                    </button>
                  ) : null}
                  {canCancel ? (
                    <button type="button" onClick={() => onRunCancel?.(run)}>
                      {isZh ? "取消" : "Cancel"}
                    </button>
                  ) : null}
                  {canRetry ? (
                    <button type="button" onClick={() => onRunRetry?.(run)}>
                      {isZh ? "重试" : "Retry"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

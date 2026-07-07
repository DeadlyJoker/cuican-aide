import type { TraceStep } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

function tokensLabel(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${n} tok`;
}

function statusLabel(status: TraceStep["status"], locale: Locale) {
  return locale === "zh"
    ? { done: "完成", running: "进行中", waiting: "等待" }[status]
    : { done: "Done", running: "Running", waiting: "Waiting" }[status];
}

type ActivityTraceProps = {
  locale: Locale;
  trace: TraceStep[];
};

export function ActivityTrace({ locale, trace }: ActivityTraceProps) {
  const isZh = locale === "zh";

  return (
    <section className="activity-card activity-trace">
      <div className="activity-card-head">
        <h2>{isZh ? "执行轨迹" : "Execution trace"}</h2>
        <span>{isZh ? "实时" : "Live"}</span>
      </div>
      <ol className="trace-timeline">
        {trace.map((step, idx) => (
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
                  {statusLabel(step.status, locale)}
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
  );
}

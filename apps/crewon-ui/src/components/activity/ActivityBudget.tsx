import type { BudgetRow } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";

function tokensLabel(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${n} tok`;
}

type ActivityBudgetProps = {
  budget: BudgetRow[];
  budgetCapUsd: number;
  locale: Locale;
};

export function ActivityBudget({
  budget,
  budgetCapUsd,
  locale,
}: ActivityBudgetProps) {
  const isZh = locale === "zh";
  const totalCost = budget.reduce((sum, row) => sum + row.costUsd, 0);
  const capPct =
    budgetCapUsd > 0
      ? Math.min(100, Math.round((totalCost / budgetCapUsd) * 100))
      : 0;

  return (
    <section className="activity-card activity-budget">
      <div className="activity-card-head">
        <h2>{isZh ? "用量与预算" : "Usage & budget"}</h2>
        <span>{`$${totalCost.toFixed(2)} / $${budgetCapUsd.toFixed(0)}`}</span>
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
        {budget.map((row) => {
          const pct = Math.min(
            100,
            row.budgetTokens > 0
              ? Math.round((row.usedTokens / row.budgetTokens) * 100)
              : 0,
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
                  <span style={{ width: `${pct}%` }} data-warn={pct >= 80} />
                </div>
                <span className="budget-tokens">{`${tokensLabel(row.usedTokens)} / ${tokensLabel(row.budgetTokens)}`}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

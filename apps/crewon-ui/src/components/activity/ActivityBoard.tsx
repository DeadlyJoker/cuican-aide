import type { Locale } from "../../lib/i18n";
import type {
  ActivityData,
  ArtifactItem,
  OfficeRunActivity,
} from "../../lib/domain/crewonDomain";
import { ActivityApprovals } from "./ActivityApprovals";
import { ActivityArtifacts } from "./ActivityArtifacts";
import { ActivityBudget } from "./ActivityBudget";
import { ActivityOfficeRuns } from "./ActivityOfficeRuns";
import { ActivityTrace } from "./ActivityTrace";

export function ActivityBoard({
  data,
  locale,
  onDecision,
  onArtifact,
  onRunCancel,
  onRunRetry,
}: {
  data: ActivityData;
  locale: Locale;
  onDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
  onRunCancel?: (run: OfficeRunActivity) => void;
  onRunRetry?: (run: OfficeRunActivity) => void;
}) {
  const runs = data.runs ?? [];

  return (
    <div className="activity-board">
      <ActivityTrace locale={locale} trace={data.trace} />

      <div className="activity-rail">
        <ActivityOfficeRuns
          locale={locale}
          runs={runs}
          onRunCancel={onRunCancel}
          onRunRetry={onRunRetry}
        />

        <ActivityApprovals
          approvals={data.approvals}
          locale={locale}
          onDecision={onDecision}
        />

        <ActivityBudget
          budget={data.budget}
          budgetCapUsd={data.budgetCapUsd}
          locale={locale}
        />

        <ActivityArtifacts
          artifacts={data.artifacts}
          locale={locale}
          onArtifact={onArtifact}
        />
      </div>
    </div>
  );
}

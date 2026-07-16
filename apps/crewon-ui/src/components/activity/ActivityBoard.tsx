import type { Locale } from "../../lib/i18n";
import type {
  ActivityData,
  ArtifactItem,
  OfficeRunActivity,
  OfficeRunDelegationActivity,
  OfficeRunVerificationCheckActivity,
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
  onDelegationDispatch,
  onDelegationCancel,
  onDelegationDispatchNext,
  onDelegationRetry,
  onVerificationCancel,
  onVerificationRetry,
  onRunCancel,
  onRunRetry,
  pendingDelegationId,
  pendingVerificationCheckId,
  pendingRunAction,
  pendingRunId,
}: {
  data: ActivityData;
  locale: Locale;
  onDecision: (id: string, decision: "approved" | "denied") => void;
  onArtifact: (artifact: ArtifactItem) => void;
  onDelegationDispatch?: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void;
  onDelegationCancel?: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void;
  onDelegationDispatchNext?: (run: OfficeRunActivity) => void;
  onDelegationRetry?: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void;
  onVerificationCancel?: (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => void;
  onVerificationRetry?: (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => void;
  onRunCancel?: (run: OfficeRunActivity) => void;
  onRunRetry?: (run: OfficeRunActivity) => void;
  pendingDelegationId?: string | null;
  pendingVerificationCheckId?: string | null;
  pendingRunAction?: "cancel" | "retry" | null;
  pendingRunId?: string | null;
}) {
  const trace = data.trace ?? [];
  const approvals = data.approvals ?? [];
  const budget = data.budget ?? [];
  const budgetCapUsd = data.budgetCapUsd ?? 0;
  const artifacts = data.artifacts ?? [];
  const runs = (data.runs ?? []).filter(
    (run) => run.messageIntent !== "conversation",
  );

  return (
    <div className="activity-board">
      {trace.length > 0 ? (
        <ActivityTrace locale={locale} trace={trace} />
      ) : null}

      <div className="activity-rail">
        <ActivityOfficeRuns
          locale={locale}
          runs={runs}
          onDelegationDispatch={onDelegationDispatch}
          onDelegationCancel={onDelegationCancel}
          onDelegationDispatchNext={onDelegationDispatchNext}
          onDelegationRetry={onDelegationRetry}
          onVerificationCancel={onVerificationCancel}
          onVerificationRetry={onVerificationRetry}
          onRunCancel={onRunCancel}
          onRunRetry={onRunRetry}
          pendingDelegationId={pendingDelegationId}
          pendingVerificationCheckId={pendingVerificationCheckId}
          pendingRunAction={pendingRunAction}
          pendingRunId={pendingRunId}
        />

        <ActivityApprovals
          approvals={approvals}
          locale={locale}
          onDecision={onDecision}
        />

        {budget.length > 0 || budgetCapUsd > 0 ? (
          <ActivityBudget
            budget={budget}
            budgetCapUsd={budgetCapUsd}
            locale={locale}
          />
        ) : null}

        <ActivityArtifacts
          artifacts={artifacts}
          locale={locale}
          onArtifact={onArtifact}
        />
      </div>
    </div>
  );
}

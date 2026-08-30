import type {
  OfficeRunActivity,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

export type OfficeComposerRuntimeMode =
  | "idle"
  | "managerConversationActive"
  | "managerActive"
  | "childActive"
  | "canceling"
  | "queued";

export type OfficeComposerRuntimeState = {
  mode: OfficeComposerRuntimeMode;
  run: OfficeRunActivity | null;
};

export type LegacyOfficeIdleConfirmation =
  | "confirmedIdle"
  | "missingThread"
  | "deny";

const NONTERMINAL_RUN_STATUSES = new Set([
  "queued",
  "running",
  "canceling",
]);
const ACTIVE_CHILD_STATUSES = new Set(["queued", "running", "canceling"]);

export function officeWorkspaceHasNonterminalRun(
  workspace: OfficeWorkspace,
): boolean {
  return Boolean(
    workspace.activity?.runs?.some((run) =>
      NONTERMINAL_RUN_STATUSES.has(run.status),
    ),
  );
}

export function deriveOfficeComposerRuntimeState(
  workspace: OfficeWorkspace,
  activeTurnByThread: Record<string, string> = {},
): OfficeComposerRuntimeState {
  const runs = workspace.activity?.runs ?? [];
  const canceling = latestRunWithStatus(runs, "canceling");
  if (canceling) {
    return { mode: "canceling", run: canceling };
  }

  const running = latestRunWithStatus(runs, "running");
  if (running) {
    if (
      running.threadId &&
      running.turnId &&
      activeTurnByThread[running.threadId] === running.turnId
    ) {
      return {
        mode:
          running.messageIntent === "conversation"
            ? "managerConversationActive"
            : "managerActive",
        run: running,
      };
    }
    if (officeRunHasExplicitActiveChild(running)) {
      return { mode: "childActive", run: running };
    }
    // A running Office Run can outlive its manager turn. Without a matching
    // active-turn receipt or an explicit child state, do not guess that steer
    // is safe; the submit endpoint owns whether this message is queued.
    return { mode: "queued", run: running };
  }

  const queued = latestRunWithStatus(runs, "queued");
  if (queued) return { mode: "queued", run: queued };
  const threadId = workspace.threadId?.trim();
  return threadId && activeTurnByThread[threadId]
    ? { mode: "queued", run: null }
    : { mode: "idle", run: null };
}

export async function confirmLegacyOfficeIdle(params: {
  activeTurnByThread: Record<string, string>;
  isMissingThreadError: (error: unknown) => boolean;
  readThread: (threadId: string) => Promise<Thread | null | undefined>;
  workspace: OfficeWorkspace;
}): Promise<LegacyOfficeIdleConfirmation> {
  if (officeWorkspaceHasNonterminalRun(params.workspace)) return "deny";
  const threadId = params.workspace.threadId?.trim();
  if (!threadId) return "missingThread";
  if (params.activeTurnByThread[threadId]) return "deny";
  let thread: Thread | null | undefined;
  try {
    thread = await params.readThread(threadId);
  } catch (error) {
    return params.isMissingThreadError(error) ? "missingThread" : "deny";
  }
  if (!thread || thread.status.type !== "idle") return "deny";
  return thread.turns.some((turn) => turn.status === "inProgress")
    ? "deny"
    : "confirmedIdle";
}

function latestRunWithStatus(
  runs: OfficeRunActivity[],
  status: OfficeRunActivity["status"],
): OfficeRunActivity | null {
  return (
    runs
      .filter((run) => run.status === status)
      .sort((left, right) =>
        officeRunTimestamp(right).localeCompare(officeRunTimestamp(left)),
      )[0] ?? null
  );
}

function officeRunTimestamp(run: OfficeRunActivity): string {
  return run.updatedAt ?? run.completedAt ?? run.createdAt ?? "";
}

function officeRunHasExplicitActiveChild(run: OfficeRunActivity): boolean {
  if (
    run.delegations?.some((delegation) =>
      ACTIVE_CHILD_STATUSES.has(delegation.status ?? ""),
    )
  ) {
    return true;
  }
  return Boolean(
    run.verificationChecks?.some((check) =>
      ACTIVE_CHILD_STATUSES.has(
        check.dispatchStatus ?? check.automationStatus ?? "",
      ),
    ),
  );
}

import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";
import type {
  AccountStatus,
  GitRemoteDiffSummary,
} from "../lib/shared/statusTypes";
import type { Locale } from "../lib/i18n";
import { inspectorPresentation } from "./InspectorPresentation";
import {
  InspectorGoalSection,
  InspectorProgressSection,
  InspectorSourcesSection,
  InspectorSummarySection,
  InspectorTaskSection,
  InspectorWorkspaceSection,
} from "./InspectorSections";

type InspectorProps = {
  account: AccountStatus | null;
  conversationSummary: ConversationSummary | null;
  gitRemoteDiff: GitRemoteDiffSummary | null;
  loadedThreadIds: string[];
  locale: Locale;
  serverUrl: string;
  thread: Thread | null;
  threadGoal: ThreadGoal | null;
};

export function Inspector({
  account,
  conversationSummary,
  gitRemoteDiff,
  loadedThreadIds,
  locale,
  serverUrl,
  thread,
  threadGoal,
}: InspectorProps) {
  const presentation = inspectorPresentation({
    account,
    conversationSummary,
    gitRemoteDiff,
    locale,
    serverUrl,
    thread,
    threadGoal,
  });

  return (
    <aside className="inspector" aria-label={presentation.copy.title}>
      <div className="inspector-panel">
        <InspectorWorkspaceSection
          loadedThreadCount={loadedThreadIds.length}
          presentation={presentation}
        />
        <InspectorProgressSection
          presentation={presentation}
          thread={thread}
        />
        <InspectorGoalSection
          presentation={presentation}
          threadGoal={threadGoal}
        />
        <InspectorTaskSection presentation={presentation} />
        <InspectorSummarySection
          conversationSummary={conversationSummary}
          presentation={presentation}
        />
        <InspectorSourcesSection presentation={presentation} />
      </div>
    </aside>
  );
}

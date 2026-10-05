import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { Locale } from "../../lib/i18n";
import { useProjectPlanningOrigin } from "./ProjectPlanningScope";
import { transcriptProjectPlanningProposal } from "./projectPlanningProposal";
import { TranscriptProjectPlanningCard } from "./TranscriptProjectPlanningCard";

/** Confirmable suggestions are visible beside the original response, outside collapsed process details. */
export function TranscriptProjectPlanningSuggestions({
  items,
  locale,
}: {
  items: readonly ThreadItem[];
  locale: Locale;
}) {
  const { navigation, runId } = useProjectPlanningOrigin();
  if (!navigation?.launch) return null;
  return (
    <>
      {items.map((item) => {
        if (item.type !== "dynamicToolCall") return null;
        const proposal = transcriptProjectPlanningProposal(item, {
          threadId: navigation.threadId,
          runId,
        });
        if (!proposal || !navigation.launch?.supports(proposal)) return null;
        return (
          <div
            className="tool-call-body project-planning-proposal"
            key={item.id}
          >
            <TranscriptProjectPlanningCard
              item={item}
              locale={locale}
              presentation="conversation"
            />
          </div>
        );
      })}
    </>
  );
}

import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import {
  PROJECT_PLANNING_MAX_BYTES,
  PROJECT_PLANNING_TOOL_NAMES,
  parseProjectPlanningProposal,
  type ProjectPlanningProposal,
} from "@crewon/contracts/project-planning";
/** Only a completed ordinary tool result bound to this actual transcript Turn is a draft suggestion. */
export function transcriptProjectPlanningProposal(
  item: Extract<ThreadItem, { type: "dynamicToolCall" }>,
  origin: Readonly<{ threadId: string | null; runId: string | null }>,
): ProjectPlanningProposal | null {
  if (
    origin.threadId === null ||
    origin.runId === null ||
    item.namespace !== null ||
    item.tool !== PROJECT_PLANNING_TOOL_NAMES.propose ||
    item.status !== "completed" ||
    item.success !== true ||
    item.contentItems?.length !== 1
  )
    return null;
  const output = item.contentItems[0];
  if (
    output?.type !== "inputText" ||
    new TextEncoder().encode(output.text).byteLength >
      PROJECT_PLANNING_MAX_BYTES
  )
    return null;
  try {
    const proposal = parseProjectPlanningProposal(JSON.parse(output.text));
    return proposal.origin.threadId === origin.threadId &&
      proposal.origin.runId === origin.runId &&
      proposal.origin.callId === item.id
      ? proposal
      : null;
  } catch {
    return null;
  }
}

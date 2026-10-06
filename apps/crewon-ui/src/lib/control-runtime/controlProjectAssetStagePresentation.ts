import type { TurnStartResponse } from "@crewon/app-server-protocol/v2/TurnStartResponse";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { GetThreadResponse } from "@crewon/contracts";
import type { ThreadRuntimeSettings } from "../thread/threadRuntimeSettings";
import type { ControlProjectAssetStageTurn } from "./controlProjectAssetStageTurn";
/** Uses the original Run adoption, transcript and streaming path after independent asset admission. */
export async function startPresentedProjectAssetStageTurn(
  input: Readonly<{
    threadId: string;
    text: string;
    settings: ThreadRuntimeSettings;
    hasAttachments: boolean;
    closed(): boolean;
    turns: ControlProjectAssetStageTurn;
    getSnapshot(threadId: string): Promise<GetThreadResponse>;
    adopt(
      receipt: Readonly<{ threadId: string; runId: string }>,
    ): Promise<unknown>;
    readThread(threadId: string): Promise<Thread>;
    changed(threadId: string): void;
  }>,
): Promise<TurnStartResponse> {
  const selection = input.settings.projectAssetStage;
  if (selection === undefined || input.closed())
    throw new Error("control_project_asset_stage_unavailable");
  if (
    input.hasAttachments ||
    input.settings.projectConversation !== undefined ||
    input.settings.projectMediaInputStage !== undefined ||
    (input.settings.executionIntent !== undefined &&
      input.settings.executionIntent !== "none") ||
    selection.binding.threadId !== input.threadId
  )
    throw new Error("control_project_asset_stage_input_unsupported");
  const current = await input.getSnapshot(input.threadId);
  if (input.closed()) throw new Error("control_thread_runtime_closed");
  const pending = input.turns.start({
    threadId: input.threadId,
    content: input.text,
    expectedThreadRevision: current.thread.revision,
    selection,
  });
  input.changed(input.threadId);
  try {
    const receipt = await pending;
    if (input.closed()) throw new Error("control_thread_runtime_closed");
    await input.adopt(receipt);
    if (input.closed()) throw new Error("control_thread_runtime_closed");
    const thread = await input.readThread(input.threadId);
    if (input.closed()) throw new Error("control_thread_runtime_closed");
    const turn = thread.turns.find((t) => t.id === receipt.runId);
    if (turn === undefined)
      throw new Error("control_project_asset_stage_adoption_invalid");
    input.turns.adopted(input.threadId, receipt.runId);
    return { turn };
  } finally {
    if (!input.closed()) input.changed(input.threadId);
  }
}

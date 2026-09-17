import type { ControlApiClient } from "@crewon/control-client";
import type { ControlRunEventStream } from "./controlRunToolProjection";
import {
  startControlTeamTurn,
  type StartControlTeamTurnInput,
} from "./controlTeamRuntime";
import {
  createControlTeamProgress,
  type ControlTeamProgress,
} from "./controlTeamProgress";

export async function startPresentedControlTeamTurn(
  input: StartControlTeamTurnInput,
  presentation: {
    client: ControlApiClient;
    eventStream: ControlRunEventStream;
    signal: AbortSignal;
    visibleContent: string;
    onChange?: (progress: ControlTeamProgress | null) => void;
  },
) {
  if (!presentation.onChange) return startControlTeamTurn(input);
  const progress = createControlTeamProgress({
    ...presentation,
    onChange: presentation.onChange,
    threadId: input.threadId,
    content: presentation.visibleContent,
    plan: input.plan,
  });
  try {
    return await startControlTeamTurn({
      ...input,
      onTaskAccepted: (message) => {
        progress.acceptedMessage(message);
        input.onTaskAccepted?.(message);
      },
      onTeamRunAccepted: (event) => {
        if (event.kind !== "managerFinal" && event.kind !== "memberFinal") {
          progress.acceptedRun(event);
        }
        return input.onTeamRunAccepted?.(event);
      },
      onFinalTurnStarted: (started) => {
        input.onFinalTurnStarted?.(started);
        progress.handoff();
      },
    });
  } catch (error) {
    progress.fail();
    throw error;
  } finally {
    progress.close();
  }
}

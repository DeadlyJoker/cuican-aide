import type {
  ToolExecutionCommand,
  ToolExecutionResolution,
  ToolRuntimePort,
} from "@crewon/tool-broker";

/** Capacity precedes recovery-attempt creation and the durable dispatch fence. */
export async function withToolExecutionCapacity<T>(
  input: {
    runtime: ToolRuntimePort;
    command: ToolExecutionCommand;
    signal: AbortSignal;
    operation: "execute" | "reconcile";
  },
  admitted: (execute: () => Promise<ToolExecutionResolution>) => Promise<T>,
): Promise<T> {
  const { runtime, command, signal, operation } = input;
  const mayExecute =
    operation === "execute" ||
    (command.actionIntent.effect === "readOnly" &&
      command.actionIntent.recovery === "replaySafe");
  const reservation = mayExecute
    ? runtime.reserveExecution?.(command, signal)
    : undefined;
  try {
    return await admitted(() =>
      reservation === undefined
        ? runtime[operation](command, signal)
        : reservation.execute(),
    );
  } finally {
    reservation?.release();
  }
}

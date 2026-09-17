import type {
  ToolExecutionCommand,
  ToolExecutionResolution,
  ToolRuntimePort,
} from "@crewon/tool-broker";

type ToolExecutionCapacityInput = {
  runtime: ToolRuntimePort;
  tenantId: string;
  command: ToolExecutionCommand;
  signal: AbortSignal;
  operation: "execute" | "reconcile";
};

function reserve(input: ToolExecutionCapacityInput) {
  const { runtime, command, signal, operation } = input;
  const mayExecute =
    operation === "execute" ||
    (command.actionIntent.effect === "readOnly" &&
      command.actionIntent.recovery === "replaySafe");
  return mayExecute
    ? runtime.reserveExecution?.(command, signal, {
        resultOwner: { tenantId: input.tenantId },
      })
    : undefined;
}

/** Detect a known pending sibling before any parallel recovery attempt is created. */
export function preflightToolExecutionCapacity(
  input: ToolExecutionCapacityInput,
): void {
  reserve(input)?.release();
}

/** Capacity precedes recovery-attempt creation and the durable dispatch fence. */
export async function withToolExecutionCapacity<T>(
  input: ToolExecutionCapacityInput,
  admitted: (execute: () => Promise<ToolExecutionResolution>) => Promise<T>,
): Promise<T> {
  const { runtime, command, signal, operation } = input;
  const reservation = reserve(input);
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

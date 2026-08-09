import { ToolBrokerError } from "./tool-broker-port.ts";

export function formatProcessToolOutput(result: {
  exitCode: number;
  wallTimeSeconds: number;
  output: string;
}): string {
  if (
    !Number.isSafeInteger(result.exitCode) ||
    !Number.isFinite(result.wallTimeSeconds) ||
    result.wallTimeSeconds < 0 ||
    typeof result.output !== "string"
  ) {
    throw new ToolBrokerError("process_tool_result_invalid");
  }
  return `Exit code: ${result.exitCode}\nWall time: ${result.wallTimeSeconds} seconds\nOutput:\n${result.output}`;
}

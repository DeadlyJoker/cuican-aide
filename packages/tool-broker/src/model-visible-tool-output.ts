import { ToolBrokerError } from "./tool-broker-port.ts";

const MAX_MODEL_VISIBLE_TOOL_OUTPUT_BYTES = 40_000;

export function modelVisibleToolOutput(output: string): Readonly<{
  output: string;
  truncated: boolean;
}> {
  const totalBytes = byteLength(output);
  if (totalBytes <= MAX_MODEL_VISIBLE_TOOL_OUTPUT_BYTES) {
    return { output, truncated: false };
  }
  const entries = [...output].map((value) => ({
    value,
    bytes: byteLength(value),
  }));
  const contentBudget = MAX_MODEL_VISIBLE_TOOL_OUTPUT_BYTES - 64;
  const halfBudget = Math.floor(contentBudget / 2);
  const head: string[] = [];
  const tail: string[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let start = 0;
  let end = entries.length - 1;
  while (start <= end && headBytes + entries[start]!.bytes <= halfBudget) {
    head.push(entries[start]!.value);
    headBytes += entries[start]!.bytes;
    start += 1;
  }
  while (
    end >= start &&
    tailBytes + entries[end]!.bytes <= contentBudget - headBytes
  ) {
    tail.unshift(entries[end]!.value);
    tailBytes += entries[end]!.bytes;
    end -= 1;
  }
  const omittedBytes = totalBytes - headBytes - tailBytes;
  const marker = `\n…${omittedBytes} bytes truncated…\n`;
  const visible = `${head.join("")}${marker}${tail.join("")}`;
  if (byteLength(visible) > MAX_MODEL_VISIBLE_TOOL_OUTPUT_BYTES) {
    throw new ToolBrokerError("tool_output_truncation_failed");
  }
  return { output: visible, truncated: true };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

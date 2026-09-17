export const SOAK_READ_TOOL = "mcp__workspace_checks__read_file";
export const SOAK_TOOL_STEPS = 4;
export const SOAK_FILE_CONTENT =
  "Isolated CrewON endurance fixture.\n" +
  "Bounded workspace payload for a real MCP read.\n".repeat(64);

export function soakPrompt(marker: string) {
  return marker.startsWith("SOAK-tool-")
    ? `${marker} Read fixture.txt four times, then return the fixture acknowledgement.`
    : `${marker} Return the fixture acknowledgement.`;
}

export function soakRequestMarker(input: readonly unknown[]) {
  const user = input.findLast(
    (item) =>
      isObject(item) &&
      item.role === "user" &&
      typeof item.content === "string" &&
      /^SOAK-[A-Za-z0-9_-]+(?:\s|$)/.test(item.content),
  );
  const text =
    isObject(user) && typeof user.content === "string" ? user.content : "";
  return text.match(/^(SOAK-[A-Za-z0-9_-]+)(?:\s|$)/)?.[1] ?? "SOAK-summary";
}

/** Choose the next read solely from validated inputs; no hidden per-turn progress cache. */
export function soakToolStep(request: Record<string, unknown>, marker: string) {
  if (!marker.startsWith("SOAK-tool-")) return null;
  if (!Array.isArray(request.input) || !Array.isArray(request.tools))
    throw new Error("soak_tool_request_invalid");
  if (
    !request.tools.some(
      (tool) =>
        isObject(tool) &&
        tool.type === "function" &&
        tool.name === SOAK_READ_TOOL,
    )
  )
    throw new Error("soak_fixture_read_tool_unavailable");
  const start = request.input.findLastIndex(
    (item) => isObject(item) && item.role === "user",
  );
  const tail: unknown[] = request.input.slice(start + 1);
  return validateSoakToolHistory(tail, marker, 0);
}

export function validateSoakToolHistory(
  tail: readonly unknown[],
  marker: string,
  initialCompleted: number,
) {
  if (
    !Number.isSafeInteger(initialCompleted) ||
    initialCompleted < 0 ||
    initialCompleted > SOAK_TOOL_STEPS
  )
    throw new Error("soak_tool_checkpoint_invalid");
  let completed = initialCompleted,
    pending: string | null = null;
  for (const item of tail) {
    if (!isObject(item)) throw new Error("soak_tool_history_invalid");
    if (item.type === "function_call") {
      const expected = `fixture_${marker}_${completed + 1}`;
      if (
        pending ||
        item.name !== SOAK_READ_TOOL ||
        item.call_id !== expected ||
        item.arguments !== '{"path":"fixture.txt"}'
      )
        throw new Error("soak_tool_call_invalid");
      pending = expected;
    } else if (item.type === "function_call_output") {
      if (
        !pending ||
        item.call_id !== pending ||
        typeof item.output !== "string"
      )
        throw new Error("soak_tool_result_binding_invalid");
      const parts = item.output.split("\n[structured]\n");
      if (parts.length !== 2) throw new Error("soak_tool_result_shape_invalid");
      const structured = JSON.parse(parts[1]!);
      if (
        !isObject(structured) ||
        structured.path !== "fixture.txt" ||
        structured.content !== SOAK_FILE_CONTENT ||
        structured.byteLength !== Buffer.byteLength(SOAK_FILE_CONTENT) ||
        structured.truncated !== false
      )
        throw new Error("soak_fixture_read_content_invalid");
      completed++;
      pending = null;
    } else throw new Error("soak_tool_history_unexpected_item");
  }
  if (pending || completed > SOAK_TOOL_STEPS)
    throw new Error("soak_tool_history_incomplete");
  return {
    completed,
    call:
      completed === SOAK_TOOL_STEPS
        ? null
        : {
            type: "function_call",
            call_id: `fixture_${marker}_${completed + 1}`,
            name: SOAK_READ_TOOL,
            arguments: '{"path":"fixture.txt"}',
          },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

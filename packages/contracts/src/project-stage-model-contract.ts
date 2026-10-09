/** A model name never authorizes a caller-selected AgentVersion or execution target. */
export function parseProjectStageModelId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    new TextEncoder().encode(value).byteLength > 256 ||
    /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)
  )
    throw new Error("project_stage_model_invalid");
  return value;
}

import { createHash } from "node:crypto";

const MAX_CATALOG_BYTES = 32 * 1024;
const MAX_MODELS = 24;
const MAX_MODEL_ID_BYTES = 256;
const MAX_VARIANT_BASE_ID_BYTES = 480;
const NON_AGENT_MODEL_MARKERS = [
  "dall-e",
  "embedding",
  "gpt-image",
  "moderation",
  "speech",
  "transcribe",
  "tts",
  "whisper",
] as const;

/** Parses the bounded Provider catalog used to build runnable model variants. */
export function runtimeModelCatalog(
  input: string | undefined,
  defaultModelId: string,
): readonly string[] {
  const defaultModel = modelId(defaultModelId);
  if (input === undefined || input.trim().length === 0) return [defaultModel];
  if (new TextEncoder().encode(input).byteLength > MAX_CATALOG_BYTES) {
    return [defaultModel];
  }
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return [defaultModel];
  }
  if (!Array.isArray(value) || value.length > 100) return [defaultModel];
  const seen = new Set([defaultModel]);
  const models = [defaultModel];
  for (const candidate of value) {
    if (models.length >= MAX_MODELS) break;
    const parsed = optionalModelId(candidate);
    if (
      parsed === null ||
      seen.has(parsed) ||
      NON_AGENT_MODEL_MARKERS.some((marker) =>
        parsed.toLowerCase().includes(marker),
      )
    ) {
      continue;
    }
    seen.add(parsed);
    models.push(parsed);
  }
  return models;
}

/** Stable child identity for a model variant of the default CrewON Agent. */
export function modelVariantAgentVersionId(
  defaultAgentVersionId: string,
  model: string,
): string | null {
  if (
    new TextEncoder().encode(defaultAgentVersionId).byteLength >
    MAX_VARIANT_BASE_ID_BYTES
  ) {
    return null;
  }
  const suffix = createHash("sha256")
    .update(modelId(model))
    .digest("hex")
    .slice(0, 24);
  return `${defaultAgentVersionId}:model-${suffix}`;
}

function modelId(value: string): string {
  const parsed = optionalModelId(value);
  if (parsed === null) throw new Error("runtime_model_catalog_default_invalid");
  return parsed;
}

function optionalModelId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= MAX_MODEL_ID_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

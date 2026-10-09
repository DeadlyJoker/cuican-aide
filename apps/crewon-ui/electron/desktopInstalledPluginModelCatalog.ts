import { desktopInstalledPluginInvalid as invalid } from "./desktopInstalledPluginRuntimeConfiguration.ts";

/** Main's captured Key discovery bounds which immutable Native model sources may be published. */
export function desktopInstalledPluginModelCatalog(
  environment: Readonly<NodeJS.ProcessEnv>,
  defaultModelId: string,
): readonly string[] {
  const input = environment.CREWON_MODEL_CATALOG_JSON;
  if (input === undefined) return Object.freeze([defaultModelId]);
  if (Buffer.byteLength(input) > 32 * 1024) invalid("model_catalog");
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    invalid("model_catalog");
  }
  if (!Array.isArray(value) || value.length > 100) invalid("model_catalog");
  const seen = new Set<string>(),
    models: string[] = [];
  for (const id of value) {
    if (
      typeof id !== "string" ||
      !id ||
      id.trim() !== id ||
      Buffer.byteLength(id) > 256 ||
      /[\u0000-\u001f\u007f]/u.test(id) ||
      seen.has(id)
    )
      invalid("model_catalog");
    seen.add(id);
    if (
      [
        "dall-e",
        "embedding",
        "gpt-image",
        "moderation",
        "speech",
        "transcribe",
        "tts",
        "whisper",
      ].some((marker) => id.toLowerCase().includes(marker))
    )
      continue;
    if (models.length < 24) models.push(id);
  }
  return Object.freeze(models);
}

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProviderCredentialStore } from "./providerCredentials.ts";

export const PACKAGED_DEFAULT_MODEL_FILE = "internal-default-model.json";
export const PACKAGED_DEFAULT_PROVIDER_ID = "crewon-test-default";
export type PackagedDefaultModel = Readonly<{
  schemaVersion: "crewon.internal-default-model.v1";
  endpoint: "https://api.aicuican.com/v1";
  modelId: string;
  apiKey: string;
}>;

/** Internal distribution only: this credential is extractable from the installer. */
export function parsePackagedDefaultModel(
  value: unknown,
): PackagedDefaultModel {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== "crewon.internal-default-model.v1" ||
    !("endpoint" in value) ||
    value.endpoint !== "https://api.aicuican.com/v1" ||
    !("modelId" in value) ||
    typeof value.modelId !== "string" ||
    !value.modelId.trim() ||
    value.modelId.length > 256 ||
    !("apiKey" in value) ||
    typeof value.apiKey !== "string" ||
    value.apiKey.trim().length < 32 ||
    value.apiKey.length > 8192
  )
    throw new Error("packaged_default_model_invalid");
  return {
    schemaVersion: "crewon.internal-default-model.v1",
    endpoint: value.endpoint,
    modelId: value.modelId.trim(),
    apiKey: value.apiKey.trim(),
  };
}

/** Fills a missing usable model; never overwrites a working user-selected provider. */
export async function provisionPackagedDefaultModel(options: {
  resourcesPath: string;
  providers: Pick<ProviderCredentialStore, "active" | "upsert">;
}): Promise<"not-bundled" | "preserved" | "provisioned"> {
  if (options.providers.active() !== null) return "preserved";
  const path = join(options.resourcesPath, PACKAGED_DEFAULT_MODEL_FILE);
  if (!existsSync(path)) return "not-bundled";
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size > 16 * 1024)
    throw new Error("packaged_default_model_invalid");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("packaged_default_model_invalid");
  }
  const profile = parsePackagedDefaultModel(raw);
  await options.providers.upsert({
    providerId: PACKAGED_DEFAULT_PROVIDER_ID,
    endpoint: profile.endpoint,
    modelId: profile.modelId,
    credentialKind: "keychain",
    environmentVariable: null,
    secret: profile.apiKey,
    activate: true,
  });
  return "provisioned";
}

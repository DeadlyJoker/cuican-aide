import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { writeDesktopConfigAtomically } from "./desktopConfigFile.ts";
import type { ActiveProvider } from "./providerCredentials.ts";

const FILE = "desktop-model-catalog-cache.json";
const SCHEMA = "crewon.desktop-model-catalog-cache.v2";

/** A gateway directory belongs to its endpoint and credential, never its default model. */
export function gatewayModelCatalogKey(provider: ActiveProvider): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        provider.providerId,
        new URL(provider.endpoint).href.replace(/\/+$/u, ""),
        provider.apiKey,
      ]),
    )
    .digest("hex");
}

export function readGatewayModelCatalog(
  directory: string,
  provider: ActiveProvider,
): readonly string[] | null {
  try {
    const path = join(directory, FILE);
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > 32 * 1024) return null;
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      value?.schemaVersion !== SCHEMA ||
      value.providerKey !== gatewayModelCatalogKey(provider)
    )
      return null;
    return parseModels(value.models);
  } catch {
    return null;
  }
}

/** Only a successful Key-backed discovery may replace the last known directory. */
export function writeGatewayModelCatalog(
  directory: string,
  provider: ActiveProvider,
  models: readonly string[],
): void {
  writeDesktopConfigAtomically(
    join(directory, FILE),
    `${JSON.stringify({
      schemaVersion: SCHEMA,
      providerKey: gatewayModelCatalogKey(provider),
      models: parseModels(models),
    })}\n`,
  );
}

function parseModels(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some(
      (id) =>
        typeof id !== "string" ||
        !id ||
        id.trim() !== id ||
        Buffer.byteLength(id) > 256 ||
        /[\u0000-\u001f\u007f]/u.test(id),
    ) ||
    new Set(value).size !== value.length
  )
    throw new Error("desktop_model_catalog_invalid");
  return Object.freeze([...value]);
}

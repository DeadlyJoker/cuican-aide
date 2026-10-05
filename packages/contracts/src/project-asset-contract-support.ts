import { ContractValidationError } from "./contract-validation-error.ts";
import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import { creativeControlTitle } from "./creative-project-control-support.ts";
import type {
  ProjectAssetContent,
  ProjectAssetKind,
} from "./project-assets-service.ts";

export const MAX_PUBLIC_PROJECT_ASSET_CONTENT_BYTES = 8 * 1024;
export function assetContractFailure(): never {
  throw new ContractValidationError("project_asset_contract_invalid");
}
export function assetContractChecked<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return assetContractFailure();
  }
}
export function assetContractCopy(input: unknown, maxBytes: number): unknown {
  return assetContractChecked(() =>
    parsePluginUiJsonValue(input, { maxBytes }),
  );
}
export function assetContractRecord(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  return assetContractChecked(() => pluginUiFields(input, fields));
}
export function assetContractRevision(
  input: unknown,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  )
    assetContractFailure();
  return input;
}
export function assetContractText(
  input: unknown,
  maximumBytes: number,
): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > maximumBytes ||
    new TextEncoder().encode(input).byteLength > maximumBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)
  )
    assetContractFailure();
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) assetContractFailure();
  }
  return input;
}
/** Historical opaque Run/plugin fields retain original characters; no path interpretation. */
export function assetContractOpaque(input: unknown): string {
  const value = assetContractText(input, 512);
  if (
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    assetContractFailure();
  return value;
}
export function assetContractId(input: unknown): string {
  const value = assetContractOpaque(input);
  if (value === "." || value === "..") assetContractFailure();
  return value;
}
export function assetContractDigest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    assetContractFailure();
  return input;
}
export function assetContractTimestamp(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length !== 24 ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  )
    assetContractFailure();
  return input;
}
export function assetContractKind(input: unknown): ProjectAssetKind {
  if (input !== "character" && input !== "scene" && input !== "prop")
    assetContractFailure();
  return input;
}
export function parsePublicProjectAssetContent(
  input: unknown,
): ProjectAssetContent {
  return assetContractChecked(() => {
    const value = assetContractRecord(
      assetContractCopy(input, MAX_PUBLIC_PROJECT_ASSET_CONTENT_BYTES),
      ["name", "setting", "visualPrompt"],
    );
    const result = Object.freeze({
      name: creativeControlTitle(value.name),
      setting: assetContractText(value.setting, 6144),
      visualPrompt: assetContractText(value.visualPrompt, 2000),
    });
    if (
      new TextEncoder().encode(JSON.stringify(result)).byteLength >
      MAX_PUBLIC_PROJECT_ASSET_CONTENT_BYTES
    )
      assetContractFailure();
    return result;
  });
}

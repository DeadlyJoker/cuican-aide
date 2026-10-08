import { extensionCanonicalJson } from "@crewon/domain";
import {
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";

/** Native bootstrap parsing owns the 256 KiB limit; extension payloads retain their 64 KiB limit. */
export function canonicalDesktopPluginConfiguration(
  input: DesktopPluginConfiguration,
): string {
  return canonicalParsedValue(parseDesktopPluginConfiguration(input));
}

function canonicalParsedValue(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalParsedValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${extensionCanonicalJson(key)}:${canonicalParsedValue(record[key])}`,
      )
      .join(",")}}`;
  }
  return extensionCanonicalJson(value);
}

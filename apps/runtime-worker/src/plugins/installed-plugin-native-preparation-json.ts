import { INSTALLED_PLUGIN_RELEASE_MAX_BYTES } from "./installed-plugin-release-document.ts";
import { ioJson } from "./plugin-execution-io-network.ts";

/** The original extension recipe's key ordering, after bounded strict own-data capture. */
export function nativePreparationCanonicalJson(input: unknown): string {
  const captured = ioJson(input, INSTALLED_PLUGIN_RELEASE_MAX_BYTES);
  const sorted = (value: typeof captured): typeof captured => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(sorted);
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          sorted((value as Readonly<Record<string, typeof captured>>)[key]),
        ]),
    );
  };
  return JSON.stringify(sorted(captured));
}

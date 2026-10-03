import { inspect } from "node:util";
import type { InstalledPluginExtensionHostDependencies } from "./installed-plugin-extension-host.ts";

export type InstalledPluginPeerConfig = Readonly<{
  port: number;
  token: string;
  deadlineMs: number;
}>;
export type InstalledPluginPeerCompositionConfig = InstalledPluginPeerConfig &
  Readonly<{
    resolveProfile: InstalledPluginExtensionHostDependencies["resolveProfile"];
  }>;
const names = [
  "CREWON_INSTALLED_PLUGIN_PEER_PORT",
  "CREWON_INSTALLED_PLUGIN_PEER_TOKEN",
  "CREWON_INSTALLED_PLUGIN_PEER_DEADLINE_MS",
] as const;

/** Explicit private peer opt-in; never supplies a principal, profile or package grant. */
export function resolveInstalledPluginPeerEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): InstalledPluginPeerConfig | undefined {
  if (names.every((name) => environment[name] === undefined)) return undefined;
  const port = decimal(required(environment, names[0]));
  const deadlineMs =
    environment[names[2]] === undefined
      ? 10_000
      : decimal(required(environment, names[2]));
  return captureInstalledPluginPeerConfig({
    port,
    token: required(environment, names[1]),
    deadlineMs,
  });
}

export function captureInstalledPluginPeerConfig(
  input: InstalledPluginPeerConfig,
): InstalledPluginPeerConfig {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of ["port", "token", "deadlineMs"])
    if (!Object.hasOwn(descriptors[key] ?? {}, "value")) invalid();
  const port: unknown = descriptors.port!.value;
  const token: unknown = descriptors.token!.value;
  const deadlineMs: unknown = descriptors.deadlineMs!.value;
  if (
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65_535 ||
    typeof deadlineMs !== "number" ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1_000 ||
    deadlineMs > 30_000 ||
    typeof token !== "string" ||
    Buffer.byteLength(token) < 32 ||
    Buffer.byteLength(token) > 8_192 ||
    /[\u0000-\u0020\u007f]/u.test(token)
  )
    invalid();
  const config = { port, token, deadlineMs } as InstalledPluginPeerConfig;
  Object.defineProperties(config, {
    [inspect.custom]: { value: () => "[InstalledPluginPeerConfig]" },
    toJSON: { value: () => ({ port, token: "[redacted]", deadlineMs }) },
  });
  return Object.freeze(config);
}
function required(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = environment[key];
  if (value === undefined || value.length === 0 || value !== value.trim())
    invalid();
  return value;
}
function decimal(input: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(input)) invalid();
  return Number(input);
}
function invalid(): never {
  throw new Error("installed_plugin_peer_configuration_invalid");
}

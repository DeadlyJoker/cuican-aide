import { constants, lstatSync, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { inspect } from "node:util";
import {
  parseDesktopInstalledPluginActivationConfiguration,
  DESKTOP_INSTALLED_PLUGIN_ACTIVATION_MAX_BYTES,
  type DesktopInstalledPluginActivationConfiguration,
} from "@crewon/contracts/plugins";
import { desktopPluginPrivatePath } from "./desktop-plugin-configuration.ts";

export const DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_ENV =
  "CREWON_DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_PATH";
export type DesktopInstalledPluginActivationConfig = Readonly<{
  publication: DesktopInstalledPluginActivationConfiguration;
  peerToken: string;
  authorityToken: string;
}>;
const issued = new WeakSet<object>();
const sourcePins = new WeakMap<
  object,
  readonly Readonly<{ path: string; stat: BigIntStats }>[]
>();
const MAX_BYTES = DESKTOP_INSTALLED_PLUGIN_ACTIVATION_MAX_BYTES;

export function assertDesktopInstalledPluginActivationConfig(
  value: unknown,
): asserts value is DesktopInstalledPluginActivationConfig {
  if (value === null || typeof value !== "object" || !issued.has(value))
    invalid();
}

/** Recheck the actual Native-issued file; copied DTOs never satisfy this source grant. */
export function assertDesktopInstalledPluginActivationConfigCurrent(
  value: DesktopInstalledPluginActivationConfig,
): void {
  assertDesktopInstalledPluginActivationConfig(value);
  try {
    for (const [index, pin] of (sourcePins.get(value) ?? []).entries()) {
      const current = lstatSync(pin.path, { bigint: true });
      if (
        index === 0
          ? !same(pin.stat, current)
          : !current.isDirectory() ||
            current.isSymbolicLink() ||
            current.dev !== pin.stat.dev ||
            current.ino !== pin.stat.ino ||
            current.mode !== pin.stat.mode ||
            current.uid !== pin.stat.uid
      )
        invalid();
    }
  } catch {
    invalid();
  }
}

/** Native metadata grants never become activation authority through a structural copy. */
export function parseDesktopInstalledPluginActivationConfig(
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): DesktopInstalledPluginActivationConfig {
  try {
    const publication =
      parseDesktopInstalledPluginActivationConfiguration(input);
    const result = {
      publication,
      peerToken: secret(environment, publication.peer.tokenEnvironmentVariable),
      authorityToken: secret(
        environment,
        publication.authority.serviceTokenEnvironmentVariable,
      ),
    };
    const redacted = () => ({
      publication,
      peerToken: "[REDACTED]",
      authorityToken: "[REDACTED]",
    });
    Object.defineProperties(result, {
      toJSON: { value: redacted },
      [inspect.custom]: { value: redacted },
    });
    Object.freeze(result);
    issued.add(result);
    return result;
  } catch {
    invalid();
  }
}

/** No explicit v3 grant means no file read, token capture or private peer. */
export async function loadDesktopInstalledPluginActivationEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  input: Readonly<{
    securityMode: "production" | "standalone";
    desktopBootstrapPath?: string;
  }>,
): Promise<DesktopInstalledPluginActivationConfig | undefined> {
  const field = Object.getOwnPropertyDescriptor(
    environment,
    DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_ENV,
  );
  if (field === undefined || ("value" in field && field.value === undefined))
    return undefined;
  if (
    !("value" in field) ||
    input.securityMode !== "standalone" ||
    input.desktopBootstrapPath === undefined ||
    process.platform === "win32"
  )
    invalid();
  try {
    const path = desktopPluginPrivatePath(field.value);
    const pins = await capture(path);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!same(pins[0]!.stat, before) || before.size > BigInt(MAX_BYTES))
        invalid();
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let count = 0;
      while (count < bytes.byteLength) {
        const part = await handle.read(
          bytes,
          count,
          bytes.length - count,
          count,
        );
        if (part.bytesRead === 0) break;
        count += part.bytesRead;
      }
      if (
        count !== Number(before.size) ||
        !same(before, await handle.stat({ bigint: true }))
      )
        invalid();
      for (const pin of pins)
        if (!same(pin.stat, await lstat(pin.path, { bigint: true }))) invalid();
      const configuration = parseDesktopInstalledPluginActivationConfig(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, count),
          ),
        ),
        environment,
      );
      sourcePins.set(configuration, pins);
      assertDesktopInstalledPluginActivationConfigCurrent(configuration);
      return configuration;
    } finally {
      await handle.close();
    }
  } catch {
    invalid();
  }
}

async function capture(path: string) {
  const pins: { path: string; stat: BigIntStats }[] = [];
  let current = path;
  while (true) {
    const stat = await lstat(current, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (pins.length === 0
        ? !stat.isFile() || stat.nlink !== 1n || stat.size === 0n
        : !stat.isDirectory()) ||
      (pins.length <= 1 &&
        (typeof process.getuid !== "function" ||
          stat.uid !== BigInt(process.getuid()) ||
          (stat.mode & 0o077n) !== 0n))
    )
      invalid();
    pins.push({ path: current, stat });
    const parent = dirname(current);
    if (parent === current) return pins;
    current = parent;
  }
}
function same(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function secret(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
) {
  const field = Object.getOwnPropertyDescriptor(environment, name);
  const value =
    field !== undefined && "value" in field ? field.value : undefined;
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 8192 ||
    !/^[\x21-\x7e]+$/u.test(value)
  )
    invalid();
  return value;
}
function invalid(): never {
  throw new Error("desktop_installed_plugin_activation_configuration_invalid");
}

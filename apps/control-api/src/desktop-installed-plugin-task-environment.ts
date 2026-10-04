import { constants, lstatSync, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { inspect } from "node:util";
import {
  DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES,
  parseDesktopInstalledPluginTaskConfiguration,
  type DesktopInstalledPluginTaskConfiguration,
} from "@crewon/contracts/plugins";
import { desktopPluginPrivatePath } from "./desktop-plugin-configuration.ts";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

export const DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV =
  "CREWON_DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_PATH";
export type DesktopInstalledPluginTaskConfig = Readonly<{
  publication: DesktopInstalledPluginTaskConfiguration;
  taskPolicyToken: string;
  uiPolicyToken: string;
  packageToken: string;
  quoteToken: string;
}>;
type SourcePin = Readonly<{ path: string; stat: BigIntStats }>;
const issued = new WeakSet<object>();
const sourcePins = new WeakMap<object, readonly SourcePin[]>();
const MAX_BYTES = DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES;

export function assertDesktopInstalledPluginTaskConfig(
  value: unknown,
): asserts value is DesktopInstalledPluginTaskConfig {
  if (value === null || typeof value !== "object" || !issued.has(value))
    invalid();
}

/** Provenance only. The current-file assertion independently rechecks the actual pins. */
export function isDesktopInstalledPluginTaskConfigFileIssued(
  value: unknown,
): value is DesktopInstalledPluginTaskConfig {
  return (
    value !== null &&
    typeof value === "object" &&
    issued.has(value) &&
    sourcePins.has(value)
  );
}

/** A programmatic parser result cannot impersonate the Main private-file loader. */
export function assertDesktopInstalledPluginTaskConfigFileIssued(
  value: unknown,
): asserts value is DesktopInstalledPluginTaskConfig {
  if (!isDesktopInstalledPluginTaskConfigFileIssued(value)) invalid();
  assertDesktopInstalledPluginTaskConfigCurrent(value);
}

/** Programmatic inputs remain programmatic; file-issued inputs retain every original pin. */
export function assertDesktopInstalledPluginTaskConfigCurrent(
  value: DesktopInstalledPluginTaskConfig,
): void {
  assertDesktopInstalledPluginTaskConfig(value);
  try {
    for (const [index, pin] of (sourcePins.get(value) ?? []).entries()) {
      const current = lstatSync(pin.path, { bigint: true });
      if (
        index === 0
          ? !same(pin.stat, current)
          : !sameDirectory(pin.stat, current)
      )
        invalid();
    }
  } catch {
    invalid();
  }
}

/** Captures explicit secrets without granting file ownership, a peer, tasks, quotes or funding. */
export function parseDesktopInstalledPluginTaskConfig(
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): DesktopInstalledPluginTaskConfig {
  try {
    const publication = parseDesktopInstalledPluginTaskConfiguration(input);
    const result = {
      publication,
      taskPolicyToken: secret(
        environment,
        publication.taskPolicyAuthority.serviceTokenEnvironmentVariable,
      ),
      uiPolicyToken: secret(
        environment,
        publication.uiPolicyAuthority.serviceTokenEnvironmentVariable,
      ),
      packageToken: secret(
        environment,
        publication.packageAuthority.serviceTokenEnvironmentVariable,
      ),
      quoteToken: secret(
        environment,
        publication.quoteAuthority.serviceTokenEnvironmentVariable,
      ),
    };
    const redacted = () => ({
      publication,
      taskPolicyToken: "[REDACTED]",
      uiPolicyToken: "[REDACTED]",
      packageToken: "[REDACTED]",
      quoteToken: "[REDACTED]",
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

/** Absent execution opt-in reads no other paths or credentials and allocates no services. */
export async function loadDesktopInstalledPluginTaskEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  input: Readonly<{
    securityMode: "production" | "standalone";
    desktopBootstrapPath?: string;
    activationConfigPath?: string;
  }>,
): Promise<DesktopInstalledPluginTaskConfig | undefined> {
  const field = Object.getOwnPropertyDescriptor(
    environment,
    DESKTOP_INSTALLED_PLUGIN_TASK_CONFIG_ENV,
  );
  if (field === undefined || ("value" in field && field.value === undefined))
    return undefined;
  try {
    if (
      !field.enumerable ||
      !("value" in field) ||
      process.platform === "win32"
    )
      invalid();
    const options = pluginSecurityRecord(input, [
      "securityMode",
      ...(Object.hasOwn(input, "desktopBootstrapPath")
        ? ["desktopBootstrapPath"]
        : []),
      ...(Object.hasOwn(input, "activationConfigPath")
        ? ["activationConfigPath"]
        : []),
    ]);
    if (
      options.securityMode !== "standalone" ||
      options.desktopBootstrapPath === undefined ||
      options.activationConfigPath === undefined
    )
      invalid();
    // These are explicit companion paths. The execution owner binds their loaded facts,
    // activation digest and bootstrap epoch; this loader never manufactures either owner.
    desktopPluginPrivatePath(options.desktopBootstrapPath);
    desktopPluginPrivatePath(options.activationConfigPath);
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
      for (const [index, pin] of pins.entries()) {
        const current = await lstat(pin.path, { bigint: true });
        if (
          index === 0
            ? !same(pin.stat, current)
            : !sameDirectory(pin.stat, current)
        )
          invalid();
      }
      const configuration = parseDesktopInstalledPluginTaskConfig(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, count),
          ),
        ),
        environment,
      );
      sourcePins.set(configuration, Object.freeze(pins));
      assertDesktopInstalledPluginTaskConfigFileIssued(configuration);
      return configuration;
    } finally {
      await handle.close();
    }
  } catch {
    invalid();
  }
}

async function capture(path: string): Promise<SourcePin[]> {
  const pins: SourcePin[] = [];
  let current = path;
  while (true) {
    const stat = await lstat(current, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (pins.length === 0
        ? !stat.isFile() ||
          stat.nlink !== 1n ||
          stat.size === 0n ||
          stat.size > BigInt(MAX_BYTES)
        : !stat.isDirectory()) ||
      (pins.length <= 1 &&
        (typeof process.getuid !== "function" ||
          stat.uid !== BigInt(process.getuid()) ||
          (stat.mode & 0o077n) !== 0n))
    )
      invalid();
    pins.push(Object.freeze({ path: current, stat }));
    const parent = dirname(current);
    if (parent === current) return pins;
    current = parent;
  }
}

function same(a: BigIntStats, b: BigIntStats): boolean {
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

/** Directory children do not carry authority; identity, type, owner and permissions do. */
function sameDirectory(a: BigIntStats, b: BigIntStats): boolean {
  return (
    b.isDirectory() &&
    !b.isSymbolicLink() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid
  );
}

function secret(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const field = Object.getOwnPropertyDescriptor(environment, name);
  const value: unknown =
    field !== undefined && field.enumerable && "value" in field
      ? field.value
      : undefined;
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
  throw new Error("desktop_installed_plugin_task_configuration_invalid");
}

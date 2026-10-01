import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  parseExtensionRecoveryManifest,
  type ExtensionRecoveryManifest,
} from "./extension-recovery.ts";

export const EXTENSION_RECOVERY_STARTUP_FILE =
  "extension-recovery-startup.json";
export const EXTENSION_RECOVERY_STARTUP_LIMIT = 256 * 1024;
const SCHEMA = "crewon.extension-recovery-startup.v0";
export type ExtensionRecoveryStartupReport = Readonly<{
  schemaVersion: typeof SCHEMA;
  attemptId: string;
}> &
  (
    | Readonly<{ outcome: "prepared"; manifest: ExtensionRecoveryManifest }>
    | Readonly<{
        outcome: "pluginUnavailable";
        reasonCode:
          | "extension_recovery_current_provider_mismatch"
          | "extension_recovery_current_credential_unavailable";
      }>
    | Readonly<{
        outcome: "unsupported";
        reasonCode: string;
        preparedInputCapsuleId: string | null;
      }>
  );

export function parseExtensionRecoveryStartupReport(
  input: unknown,
): ExtensionRecoveryStartupReport {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const value = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => {
      if (!descriptor.enumerable || !("value" in descriptor)) invalid();
      return [key, descriptor.value];
    }),
  );
  const keys =
    value.outcome === "prepared"
      ? ["schemaVersion", "attemptId", "outcome", "manifest"]
      : value.outcome === "pluginUnavailable"
        ? ["schemaVersion", "attemptId", "outcome", "reasonCode"]
        : [
            "schemaVersion",
            "attemptId",
            "outcome",
            "reasonCode",
            "preparedInputCapsuleId",
          ];
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    value.schemaVersion !== SCHEMA ||
    typeof value.attemptId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.attemptId)
  )
    invalid();
  const common = { schemaVersion: SCHEMA, attemptId: value.attemptId } as const;
  if (value.outcome === "prepared")
    return Object.freeze({
      ...common,
      outcome: "prepared",
      manifest: parseExtensionRecoveryManifest(value.manifest),
    });
  if (value.outcome === "pluginUnavailable") {
    if (
      value.reasonCode !== "extension_recovery_current_provider_mismatch" &&
      value.reasonCode !== "extension_recovery_current_credential_unavailable"
    )
      invalid();
    return Object.freeze({
      ...common,
      outcome: "pluginUnavailable",
      reasonCode: value.reasonCode,
    });
  }
  if (
    value.outcome !== "unsupported" ||
    typeof value.reasonCode !== "string" ||
    !/^[a-z][a-z0-9_]{0,127}$/u.test(value.reasonCode) ||
    (value.preparedInputCapsuleId !== null &&
      (typeof value.preparedInputCapsuleId !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(value.preparedInputCapsuleId)))
  )
    invalid();
  return Object.freeze({
    ...common,
    outcome: "unsupported",
    reasonCode: value.reasonCode,
    preparedInputCapsuleId: value.preparedInputCapsuleId as string | null,
  });
}

/** Fixed native handoff only. Current selector is replaceable; capsules remain immutable. */
export async function writeExtensionRecoveryStartupReport(
  input: Readonly<{
    dataRoot: string;
    report: ExtensionRecoveryStartupReport;
  }>,
): Promise<void> {
  const dataRoot = checkedRoot(input.dataRoot);
  const report = parseExtensionRecoveryStartupReport(input.report);
  const bytes = Buffer.from(`${JSON.stringify(report)}\n`, "utf8");
  if (bytes.length > EXTENSION_RECOVERY_STARTUP_LIMIT) invalid();
  await assertRoot(dataRoot);
  const target = join(dataRoot, EXTENSION_RECOVERY_STARTUP_FILE);
  try {
    const existing = await readReportBytes(target);
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(existing),
      );
    } catch {
      invalid();
    }
    parseExtensionRecoveryStartupReport(value);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const pending = `${target}.pending-v1`;
  const descriptor = await open(pending, "wx", 0o600);
  let failure: unknown;
  try {
    await descriptor.writeFile(bytes);
    await descriptor.sync();
    await descriptor.close();
    await rename(pending, target);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await descriptor.close().catch(() => undefined);
    if (failure !== undefined) {
      try {
        await unlink(pending);
      } catch (error) {
        throw new AggregateError(
          [failure, error],
          "extension_recovery_startup_cleanup_failed",
        );
      }
    }
  }
}

export async function readExtensionRecoveryStartupReport(
  input: Readonly<{
    dataRoot: string;
    expectedAttemptId: string;
  }>,
): Promise<ExtensionRecoveryStartupReport> {
  const dataRoot = checkedRoot(input.dataRoot);
  const expected = input.expectedAttemptId;
  if (!/^[a-f0-9]{64}$/u.test(expected)) invalid();
  await assertRoot(dataRoot);
  const bytes = await readReportBytes(
    join(dataRoot, EXTENSION_RECOVERY_STARTUP_FILE),
  );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid();
  }
  const report = parseExtensionRecoveryStartupReport(value);
  if (report.attemptId !== expected)
    throw new Error("extension_recovery_startup_attempt_mismatch");
  return report;
}

async function readReportBytes(path: string): Promise<Buffer> {
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await descriptor.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 2 ||
      before.size > EXTENSION_RECOVERY_STARTUP_LIMIT
    )
      invalid();
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await descriptor.read(
        bytes,
        used,
        bytes.length - used,
        null,
      );
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    const after = await descriptor.stat();
    if (
      used !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      invalid();
    return bytes.subarray(0, used);
  } finally {
    await descriptor.close();
  }
}
function checkedRoot(input: unknown): string {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    input.trim() !== input ||
    Buffer.byteLength(input) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    invalid();
  return input;
}
async function assertRoot(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep)) {
    if (!component) continue;
    current = join(current, component);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid();
  }
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function invalid(): never {
  throw new Error("extension_recovery_startup_invalid");
}

import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  captureWorkflowDeploymentConfiguration,
  type WorkflowDeploymentConfiguration,
} from "@crewon/application";

export const WORKFLOW_DEPLOYMENT_CONFIG_ENV =
  "CREWON_WORKFLOW_DEPLOYMENT_CONFIG_PATH";
const MAX_BYTES = 256 * 1024;

/** Host-only opt-in. No filesystem access for absent or unsupported deployment modes. */
export function loadWorkflowDeploymentEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  securityMode: "standalone" | "production",
): WorkflowDeploymentConfiguration | undefined {
  const path = environment[WORKFLOW_DEPLOYMENT_CONFIG_ENV];
  if (path === undefined) return undefined;
  if (
    securityMode !== "standalone" ||
    !environment.CREWON_CONTROL_DATABASE_URL?.trim()
  )
    throw new Error("workflow_deployment_requires_standalone_postgres");
  try {
    if (
      !path ||
      path.trim() !== path ||
      !isAbsolute(path) ||
      resolve(path) !== path ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path) ||
      Buffer.byteLength(path) > 4096 ||
      Buffer.from(path).toString() !== path ||
      typeof process.getuid !== "function" ||
      process.platform === "win32"
    )
      invalid();
    const uid = BigInt(process.getuid());
    const original = lstatSync(path, { bigint: true });
    if (!privateFile(original, uid) || realpathSync(path) !== path) invalid();
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!privateFile(before, uid) || !sameFile(original, before)) invalid();
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = readSync(fd, bytes, size, bytes.length - size, null);
        if (read === 0) break;
        size += read;
      }
      const after = fstatSync(fd, { bigint: true });
      const current = lstatSync(path, { bigint: true });
      if (
        size > MAX_BYTES ||
        BigInt(size) !== before.size ||
        !sameFile(before, after) ||
        !sameFile(before, current) ||
        realpathSync(path) !== path
      )
        invalid();
      return captureWorkflowDeploymentConfiguration(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, size),
          ),
        ),
      );
    } finally {
      closeSync(fd);
    }
  } catch {
    invalid();
  }
}
function privateFile(stat: BigIntStats, uid: bigint): boolean {
  return (
    stat.isFile() &&
    stat.uid === uid &&
    stat.nlink === 1n &&
    (stat.mode & 0o077n) === 0n &&
    stat.size > 0n &&
    stat.size <= BigInt(MAX_BYTES)
  );
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    [
      "dev",
      "ino",
      "uid",
      "mode",
      "nlink",
      "size",
      "mtimeNs",
      "ctimeNs",
    ] as const
  ).every((key) => a[key] === b[key]);
}
function invalid(): never {
  throw new Error("workflow_deployment_configuration_invalid");
}

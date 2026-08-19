import { rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const RUNTIME_READINESS_FILE_ENV = "CREWON_RUNTIME_READINESS_FILE";

type Environment = Readonly<Record<string, string | undefined>>;

export function resolveRuntimeReadinessFile(
  environment: Environment,
): string | null {
  const value = environment[RUNTIME_READINESS_FILE_ENV];
  if (value === undefined) return null;
  const path = value.trim();
  if (
    path.length === 0 ||
    Buffer.byteLength(path, "utf8") > 1024 ||
    !isAbsolute(path) ||
    path.includes("\0")
  ) {
    throw new Error(`${RUNTIME_READINESS_FILE_ENV}_invalid`);
  }
  return path;
}

export async function clearRuntimeReadinessFile(
  path: string | null,
): Promise<void> {
  if (path !== null) await rm(path, { force: true });
}

export async function markRuntimeReady(path: string | null): Promise<void> {
  if (path === null) return;
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await rm(temporaryPath, { force: true });
  try {
    await writeFile(temporaryPath, `${process.pid}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
